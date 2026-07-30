import type {
  ComponentDataSnapshot,
  ConnectorConnectionSnapshot,
  ConsoleConfig,
  KnowledgeDocumentSnapshot,
  MCPAuthenticatedClientSnapshot,
  RuntimeAgentSnapshot,
  RuntimeEventSnapshot,
  TraceSnapshot,
} from "../control-plane/types";
import { checkServices } from "./services";
import { readGatewayChannels } from "./gateway-config";

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
  const base = process.env.AGENT_RUNTIME_URL || "http://runtime.localhost:8080";
  const [ready, agents, events] = await Promise.all([
    fetchJson<{
      database?: string;
      pgvector?: string;
      apacheAge?: string;
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
    apacheAge: ready.apacheAge || "missing",
    databaseSizeBytes: ready.databaseSizeBytes || 0,
    eventCount: ready.runtimeEvents || 0,
    eventTypes: ready.runtimeEventTypes || {},
    agents: agents.items || [],
    recentEvents: events.items || [],
  };
}

async function collectLlmGateway() {
  const snapshot = await readGatewayChannels();
  const enabledChannels = snapshot.channels.filter((channel) => channel.enabled && channel.keyConfigured);
  const models = enabledChannels.flatMap((channel) => channel.models.map((model) => model.publicName));
  return { channelCount: enabledChannels.length, modelCount: models.length, models };
}

type ConnectorConnectionPayload = {
  id?: string;
  service?: string;
  connectionName?: string;
  authType?: string;
  configured?: boolean;
  virtual?: boolean;
  default?: boolean;
};

async function collectConnector() {
  const base = process.env.OPEN_CONNECTOR_URL || "http://localhost:8080/connector";
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
    connectionCount: connectionsPayload.filter((item) => !item.virtual).length,
    recentRunCount: runsPayload.items?.length ?? 0,
    connections,
  };
}

async function collectKnowledge(): Promise<ComponentDataSnapshot["knowledge"]> {
  const base = process.env.LIGHTRAG_URL || "http://localhost:8080/rag";
  const [health, payload] = await Promise.all([
    fetchJson<{ pipeline_busy?: boolean }>(`${base}/health`),
    fetchJson<{
      documents?: Array<{
        content_summary?: string;
        content_length?: number;
        status?: string;
        updated_at?: string;
        chunks_count?: number;
        error_msg?: string | null;
        file_path?: string;
      }>;
      pagination?: { total_count?: number };
      status_counts?: Record<string, number>;
    }>(`${base}/documents/paginated`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        page: 1,
        page_size: 200,
        sort_field: "updated_at",
        sort_direction: "desc",
      }),
    }),
  ]);
  const documents: KnowledgeDocumentSnapshot[] = (payload.documents || []).map((document, index) => {
    const relativePath = document.file_path || `document-${index + 1}`;
    const fileName = relativePath.split("/").filter(Boolean).at(-1) || relativePath;
    return {
      name: fileName.replace(/\.[^.]+$/, "") || document.content_summary || `文档 ${index + 1}`,
      relativePath,
      sizeBytes: document.content_length || 0,
      modifiedAt: document.updated_at || new Date(0).toISOString(),
      status: document.status || "UNKNOWN",
      chunksCount: document.chunks_count || 0,
      errorMessage: document.error_msg || undefined,
    };
  });
  return {
    documentCount: payload.pagination?.total_count ?? documents.length,
    totalBytes: documents.reduce((sum, document) => sum + document.sizeBytes, 0),
    latestModifiedAt: documents[0]?.modifiedAt,
    pipelineBusy: Boolean(health.pipeline_busy),
    statusCounts: payload.status_counts || {},
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
  const base = process.env.JAEGER_URL || "http://jaeger.localhost:8080";
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

async function collectAuthentication(): Promise<ComponentDataSnapshot["authentication"]> {
  const base = process.env.MCP_ACCESS_GATEWAY_URL || "http://mcp-access-gateway:8081";
  const response = await fetchJson<{
    retentionSeconds?: number;
    activeWindowSeconds?: number;
    clients?: MCPAuthenticatedClientSnapshot[];
  }>(`${base}/internal/v1/authentication/mcp-clients`, {
    headers: bearer(process.env.MCP_ADMIN_TOKEN),
  });
  const clients = response.clients || [];

  return {
    identityCount: clients.length,
    activeIdentityCount: clients.filter((client) => client.active).length,
    oauthClientCount: new Set(clients.map((client) => client.clientId)).size,
    requestCount: clients.reduce((sum, client) => sum + client.requestCount, 0),
    retentionSeconds: response.retentionSeconds || 0,
    activeWindowSeconds: response.activeWindowSeconds || 0,
    clients,
  };
}

async function collectEvaluation() {
  const base = process.env.PROMPTFOO_URL || "http://promptfoo.localhost:8080";
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

  const [services, runtime, modelGateway, connector, knowledge, tracing, authentication, evaluation] = await Promise.all([
    checkServices(config),
    safe("runtime", collectRuntime, { database: "unknown", pgvector: "missing", apacheAge: "missing", databaseSizeBytes: 0, eventCount: 0, eventTypes: {}, agents: [], recentEvents: [] }),
    safe("llmGateway", collectLlmGateway, { channelCount: 0, modelCount: 0, models: [] }),
    safe("openConnector", collectConnector, { providerCount: 0, appCount: 0, authenticatedAppCount: 0, connectionCount: 0, recentRunCount: 0, connections: [] }),
    safe("knowledge", collectKnowledge, {
      documentCount: 0,
      totalBytes: 0,
      latestModifiedAt: undefined,
      pipelineBusy: false,
      statusCounts: {},
      documents: [],
    }),
    safe("jaeger", collectTracing, { serviceCount: 0, recentTraceCount: 0, spanCount: 0, errorTraceCount: 0, traces: [] }),
    safe("mcpAuthentication", collectAuthentication, {
      identityCount: 0,
      activeIdentityCount: 0,
      oauthClientCount: 0,
      requestCount: 0,
      retentionSeconds: 0,
      activeWindowSeconds: 0,
      clients: [],
    }),
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
    authentication,
    evaluation,
    errors,
  };
  cache = { expiresAt: Date.now() + CACHE_TTL_MS, value };
  return value;
}
