import { readdir, stat } from "node:fs/promises";
import path from "node:path";

import type {
  ComponentDataSnapshot,
  ConnectorConnectionSnapshot,
  ConsoleConfig,
  KnowledgeDocumentSnapshot,
  RuntimeAgentSnapshot,
  RuntimeEventSnapshot,
  TraceSnapshot,
} from "../control-plane/types";
import { checkServices } from "./services";

const FETCH_TIMEOUT_MS = 2_500;
const CACHE_TTL_MS = 10_000;

let cache: { expiresAt: number; value: ComponentDataSnapshot } | undefined;

async function fetchJson<T>(url: string, init?: RequestInit): Promise<T> {
  const response = await fetch(url, {
    ...init,
    cache: "no-store",
    signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
  });
  if (!response.ok) throw new Error(`${response.status} ${response.statusText}`);
  return response.json() as Promise<T>;
}

function bearer(token: string | undefined): HeadersInit | undefined {
  return token ? { Authorization: `Bearer ${token}` } : undefined;
}

async function collectRuntime() {
  const base = process.env.AGENT_RUNTIME_URL || "http://localhost:18000";
  const [ready, agents, events] = await Promise.all([
    fetchJson<{
      database?: string;
      pgvector?: string;
      databaseSizeBytes?: number;
      runtimeEvents?: number;
      runtimeEventTypes?: Record<string, number>;
    }>(`${base}/ready`),
    fetchJson<{ items?: RuntimeAgentSnapshot[] }>(`${base}/v1/agents`),
    fetchJson<{ items?: RuntimeEventSnapshot[] }>(`${base}/v1/runtime-events`),
  ]);

  return {
    database: ready.database || "unknown",
    pgvector: ready.pgvector || "missing",
    databaseSizeBytes: ready.databaseSizeBytes || 0,
    eventCount: ready.runtimeEvents || 0,
    eventTypes: ready.runtimeEventTypes || {},
    agents: agents.items || [],
    recentEvents: events.items || [],
  };
}

async function collectBifrost() {
  const base = process.env.BIFROST_URL || "http://localhost:8080";
  const [providers, models, logs] = await Promise.all([
    fetchJson<{ providers?: unknown[]; total?: number }>(`${base}/api/providers`),
    fetchJson<{ data?: unknown[] }>(`${base}/v1/models`),
    fetchJson<{
      pagination?: { total_count?: number };
      stats?: {
        total_requests?: number;
        success_rate?: number;
        average_latency?: number;
        total_tokens?: number;
        total_cost?: number;
      };
    }>(`${base}/api/logs?limit=1`),
  ]);
  const requestCount = logs.stats?.total_requests ?? logs.pagination?.total_count ?? 0;

  return {
    providerCount: providers.total ?? providers.providers?.length ?? 0,
    modelCount: models.data?.length ?? 0,
    requestCount,
    successRate: requestCount > 0 ? (logs.stats?.success_rate ?? 0) : null,
    averageLatencyMs: requestCount > 0 ? (logs.stats?.average_latency ?? 0) : null,
    totalTokens: logs.stats?.total_tokens ?? 0,
    totalCostUsd: logs.stats?.total_cost ?? 0,
  };
}

type ConnectorConnectionPayload = {
  id?: string;
  service?: string;
  connectionName?: string;
  authType?: string;
  configured?: boolean;
  default?: boolean;
};

async function collectConnector() {
  const base = process.env.OPEN_CONNECTOR_URL || "http://localhost:3100";
  const runtimeHeaders = bearer(process.env.OPEN_CONNECTOR_RUNTIME_TOKEN);
  const adminHeaders = bearer(process.env.OPEN_CONNECTOR_ADMIN_TOKEN);
  const [providers, apps, authenticatedApps] = await Promise.all([
    fetchJson<{ data?: unknown[] }>(`${base}/v1/providers`, { headers: runtimeHeaders }),
    fetchJson<{ data?: unknown[] }>(`${base}/v1/apps`, { headers: runtimeHeaders }),
    fetchJson<{ data?: unknown[] }>(`${base}/v1/apps/authenticated`, { headers: runtimeHeaders }),
  ]);

  const connectionsPayload = adminHeaders
    ? await fetchJson<ConnectorConnectionPayload[]>(`${base}/api/connections`, { headers: adminHeaders })
    : [];
  const runsPayload = adminHeaders
    ? await fetchJson<{ items?: unknown[] }>(`${base}/api/runs`, { headers: adminHeaders })
    : { items: [] };
  const connections: ConnectorConnectionSnapshot[] = connectionsPayload.map((item) => ({
    id: item.id || `${item.service || "unknown"}:${item.connectionName || "default"}`,
    service: item.service || "unknown",
    connectionName: item.connectionName || "default",
    authType: item.authType || "unknown",
    configured: Boolean(item.configured),
    isDefault: Boolean(item.default),
  }));

  return {
    providerCount: providers.data?.length ?? 0,
    appCount: apps.data?.length ?? 0,
    authenticatedAppCount: authenticatedApps.data?.length ?? 0,
    connectionCount: connections.length || apps.data?.length || 0,
    recentRunCount: runsPayload.items?.length ?? 0,
    connections,
  };
}

async function walkMarkdown(directory: string, root = directory): Promise<KnowledgeDocumentSnapshot[]> {
  const entries = await readdir(directory, { withFileTypes: true });
  const documents: KnowledgeDocumentSnapshot[] = [];
  for (const entry of entries) {
    if (entry.name.startsWith(".")) continue;
    const absolutePath = path.join(directory, entry.name);
    if (entry.isDirectory()) {
      documents.push(...await walkMarkdown(absolutePath, root));
    } else if (entry.isFile() && entry.name.toLowerCase().endsWith(".md")) {
      const metadata = await stat(absolutePath);
      documents.push({
        name: entry.name.replace(/\.md$/i, ""),
        relativePath: path.relative(root, absolutePath),
        sizeBytes: metadata.size,
        modifiedAt: metadata.mtime.toISOString(),
      });
    }
  }
  return documents.sort((left, right) => right.modifiedAt.localeCompare(left.modifiedAt));
}

async function collectKnowledge(): Promise<ComponentDataSnapshot["knowledge"]> {
  const directory = process.env.SILVERBULLET_SPACE_DIR
    || path.resolve(process.cwd(), "../deploy/silverbullet/space");
  const documents = await walkMarkdown(directory);
  return {
    documentCount: documents.length,
    totalBytes: documents.reduce((sum, document) => sum + document.sizeBytes, 0),
    latestModifiedAt: documents[0]?.modifiedAt,
    documents,
  };
}

type JaegerTag = { key?: string; value?: unknown };
type JaegerSpan = {
  operationName?: string;
  processID?: string;
  startTime?: number;
  duration?: number;
  tags?: JaegerTag[];
};
type JaegerTrace = {
  traceID?: string;
  spans?: JaegerSpan[];
  processes?: Record<string, { serviceName?: string }>;
};

export function summarizeJaegerTrace(trace: JaegerTrace): TraceSnapshot | undefined {
  const spans = trace.spans || [];
  if (!trace.traceID || spans.length === 0) return undefined;
  const firstSpan = spans.reduce((earliest, span) =>
    (span.startTime || 0) < (earliest.startTime || 0) ? span : earliest,
  );
  const startTime = Math.min(...spans.map((span) => span.startTime || 0));
  const endTime = Math.max(...spans.map((span) => (span.startTime || 0) + (span.duration || 0)));
  const hasError = spans.some((span) => span.tags?.some((tag) =>
    (tag.key === "error" && tag.value === true)
      || (tag.key === "http.status_code" && Number(tag.value) >= 400),
  ));

  return {
    traceId: trace.traceID,
    serviceName: trace.processes?.[firstSpan.processID || ""]?.serviceName || "unknown",
    operationName: firstSpan.operationName || "unknown",
    spanCount: spans.length,
    durationMs: Math.max(0, Math.round((endTime - startTime) / 1_000)),
    startedAt: new Date(startTime / 1_000).toISOString(),
    status: hasError ? "degraded" : "healthy",
  };
}

async function collectTracing() {
  const base = process.env.JAEGER_URL || "http://localhost:16686";
  const serviceName = process.env.JAEGER_SERVICE_NAME || "ai-base-agent-runtime";
  const [services, tracesPayload] = await Promise.all([
    fetchJson<{ data?: string[]; total?: number }>(`${base}/api/services`),
    fetchJson<{ data?: JaegerTrace[] }>(
      `${base}/api/traces?service=${encodeURIComponent(serviceName)}&limit=100`,
    ),
  ]);
  const traces = (tracesPayload.data || [])
    .map(summarizeJaegerTrace)
    .filter((trace): trace is TraceSnapshot => Boolean(trace))
    .sort((left, right) => right.startedAt.localeCompare(left.startedAt));

  return {
    serviceCount: services.total ?? services.data?.length ?? 0,
    recentTraceCount: traces.length,
    spanCount: traces.reduce((sum, trace) => sum + trace.spanCount, 0),
    errorTraceCount: traces.filter((trace) => trace.status === "degraded").length,
    traces,
  };
}

async function collectEvaluation() {
  const base = process.env.PROMPTFOO_URL || "http://localhost:3002";
  try {
    await fetchJson<unknown>(`${base}/health`);
    return { status: "running" as const, resultCount: 0, detail: "Promptfoo 容器已启动；尚未接入结果导出。" };
  } catch {
    return { status: "idle" as const, resultCount: 0, detail: "Promptfoo Docker profile 当前未运行。" };
  }
}

export async function getComponentData(
  config: ConsoleConfig,
  options: { force?: boolean } = {},
): Promise<ComponentDataSnapshot> {
  if (!options.force && cache && cache.expiresAt > Date.now()) return cache.value;

  const errors: Record<string, string> = {};
  async function safe<T>(name: string, collector: () => Promise<T>, fallback: T): Promise<T> {
    try {
      return await collector();
    } catch (error) {
      errors[name] = error instanceof Error ? error.message : "unknown error";
      return fallback;
    }
  }

  const [services, runtime, modelGateway, connector, knowledge, tracing, evaluation] = await Promise.all([
    checkServices(config),
    safe("runtime", collectRuntime, { database: "unknown", pgvector: "missing", databaseSizeBytes: 0, eventCount: 0, eventTypes: {}, agents: [], recentEvents: [] }),
    safe("bifrost", collectBifrost, { providerCount: 0, modelCount: 0, requestCount: 0, successRate: null, averageLatencyMs: null, totalTokens: 0, totalCostUsd: 0 }),
    safe("openConnector", collectConnector, { providerCount: 0, appCount: 0, authenticatedAppCount: 0, connectionCount: 0, recentRunCount: 0, connections: [] }),
    safe("knowledge", collectKnowledge, { documentCount: 0, totalBytes: 0, latestModifiedAt: undefined, documents: [] }),
    safe("jaeger", collectTracing, { serviceCount: 0, recentTraceCount: 0, spanCount: 0, errorTraceCount: 0, traces: [] }),
    collectEvaluation(),
  ]);
  const value: ComponentDataSnapshot = {
    generatedAt: new Date().toISOString(),
    services,
    runtime,
    modelGateway,
    connector,
    knowledge,
    tracing,
    evaluation,
    errors,
  };
  cache = { expiresAt: Date.now() + CACHE_TTL_MS, value };
  return value;
}
