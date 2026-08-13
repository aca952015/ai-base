const FETCH_TIMEOUT_MS = 2_500;
const CACHE_TTL_MS = 10_000;
const MAX_TRACE_SEARCH_WINDOW_MS = 24 * 60 * 60 * 1_000;
const MAX_TRACE_SEARCH_RESULTS = 100;

export type ObservabilityRange = "15m" | "1h" | "24h" | "7d";
export type ObservabilityKind = "model" | "mcp";
export type ObservabilityStatus = "ok" | "error" | "denied";

export type MetricValue = {
  value: number | null;
  available: boolean;
  reason?: string;
};

export type ObservabilitySummary = {
  generatedAt: string;
  range: ObservabilityRange;
  partial: boolean;
  sources: {
    metrics: "healthy" | "partial" | "offline";
    message?: string;
  };
  model: {
    calls: MetricValue;
    errorRate: MetricValue;
    p95LatencyMs: MetricValue;
    inputTokens: MetricValue;
    outputTokens: MetricValue;
    ttftP95Ms: MetricValue;
  };
  mcp: {
    calls: MetricValue;
    deniedRate: MetricValue;
    errorRate: MetricValue;
    p95LatencyMs: MetricValue;
  };
};

export type ObservabilityCall = {
  traceId: string;
  spanId: string;
  kind: ObservabilityKind;
  startedAt: string;
  durationMs: number;
  status: ObservabilityStatus;
  source: string;
  target: string;
  operation: string;
  errorType?: string;
  requestModel?: string;
  responseModel?: string;
  provider?: string;
  inputTokens?: number;
  outputTokens?: number;
  totalTokens?: number;
  method?: string;
  server?: string;
  tool?: string;
  action?: string;
  decision?: "allow" | "deny";
  reason?: string;
  principalFingerprint?: string;
  oauthClient?: string;
  connection?: string;
};

export type ObservabilityCallsResult = {
  items: ObservabilityCall[];
  kind: ObservabilityKind;
  scannedTraces: number;
  truncated: boolean;
  window: { from: string; to: string };
  source: "healthy" | "offline";
  message?: string;
};

export type ObservabilitySpan = {
  spanId: string;
  parentSpanId?: string;
  name: string;
  serviceName: string;
  startedAt: string;
  durationMs: number;
  status: ObservabilityStatus;
  kind?: ObservabilityKind;
  target?: string;
  operation?: string;
  errorType?: string;
  decision?: "allow" | "deny";
  reason?: string;
};

export type ObservabilityTraceDetail = {
  traceId: string;
  startedAt: string;
  durationMs: number;
  status: ObservabilityStatus;
  spans: ObservabilitySpan[];
  calls: ObservabilityCall[];
  jaegerUrl?: string;
};

export class ObservabilityRequestError extends Error {
  readonly status: number;

  constructor(message: string, status = 400) {
    super(message);
    this.name = "ObservabilityRequestError";
    this.status = status;
  }
}

type JsonObject = Record<string, unknown>;
type CacheEntry<T> = { expiresAt: number; value: T };
const summaryCache = new Map<string, CacheEntry<ObservabilitySummary>>();
const callsCache = new Map<string, CacheEntry<ObservabilityCallsResult>>();
const traceCache = new Map<string, CacheEntry<ObservabilityTraceDetail | undefined>>();

function object(value: unknown): JsonObject | undefined {
  return value && typeof value === "object" && !Array.isArray(value) ? value as JsonObject : undefined;
}

function array(value: unknown): unknown[] {
  return Array.isArray(value) ? value : [];
}

function text(value: unknown): string | undefined {
  return typeof value === "string" && value.trim() ? value.trim() : undefined;
}

function finite(value: unknown): number | undefined {
  const parsed = typeof value === "number" ? value : typeof value === "string" ? Number(value) : NaN;
  return Number.isFinite(parsed) ? parsed : undefined;
}

function scalar(value: unknown): string | number | boolean | undefined {
  if (typeof value === "string" || typeof value === "number" || typeof value === "boolean") return value;
  const wrapped = object(value);
  if (!wrapped) return undefined;
  const stringValue = text(wrapped.stringValue ?? wrapped.string_value);
  if (stringValue !== undefined) return stringValue;
  const numberValue = finite(wrapped.intValue ?? wrapped.int_value ?? wrapped.doubleValue ?? wrapped.double_value);
  if (numberValue !== undefined) return numberValue;
  const boolValue = wrapped.boolValue ?? wrapped.bool_value;
  return typeof boolValue === "boolean" ? boolValue : undefined;
}

function attributes(value: unknown): Map<string, string | number | boolean> {
  const result = new Map<string, string | number | boolean>();
  if (Array.isArray(value)) {
    for (const item of value) {
      const entry = object(item);
      const key = text(entry?.key);
      const decoded = scalar(entry?.value);
      if (key && decoded !== undefined) result.set(key, decoded);
    }
  } else {
    for (const [key, raw] of Object.entries(object(value) ?? {})) {
      const decoded = scalar(raw);
      if (decoded !== undefined) result.set(key, decoded);
    }
  }
  return result;
}

function firstAttribute(attrs: Map<string, string | number | boolean>, keys: string[]) {
  for (const key of keys) if (attrs.has(key)) return attrs.get(key);
  return undefined;
}

function attrText(attrs: Map<string, string | number | boolean>, keys: string[]) {
  const value = firstAttribute(attrs, keys);
  return value === undefined ? undefined : String(value);
}

function attrNumber(attrs: Map<string, string | number | boolean>, keys: string[]) {
  return finite(firstAttribute(attrs, keys));
}

function timestampMicros(value: unknown): number | undefined {
  if (typeof value === "string" && /T/.test(value)) {
    const parsed = Date.parse(value);
    return Number.isFinite(parsed) ? parsed * 1_000 : undefined;
  }
  const number = finite(value);
  if (number === undefined) return undefined;
  if (number > 1e17) return number / 1_000;
  if (number > 1e14) return number;
  if (number > 1e11) return number * 1_000;
  return number * 1_000_000;
}

function durationMicros(span: JsonObject): number {
  const direct = finite(span.duration ?? span.durationMicros ?? span.duration_micros);
  if (direct !== undefined) return Math.max(0, direct);
  const start = timestampMicros(span.startTime ?? span.start_time ?? span.startTimeUnixNano ?? span.start_time_unix_nano);
  const end = timestampMicros(span.endTime ?? span.end_time ?? span.endTimeUnixNano ?? span.end_time_unix_nano);
  return start !== undefined && end !== undefined ? Math.max(0, end - start) : 0;
}

function statusFromSpan(span: JsonObject, attrs: Map<string, string | number | boolean>): ObservabilityStatus {
  const decision = attrText(attrs, ["mcp.authorization.decision", "authorization.decision", "mcp.decision"]);
  if (decision === "deny") return "denied";
  const status = object(span.status);
  const code = text(status?.code)?.toUpperCase() ?? finite(status?.code);
  const httpCode = attrNumber(attrs, ["http.response.status_code", "http.status_code"]);
  const errorType = attrText(attrs, ["error.type"]);
  if (code === "STATUS_CODE_ERROR" || code === "ERROR" || code === 2 || (httpCode ?? 0) >= 400 || errorType) return "error";
  return "ok";
}

function serviceName(span: JsonObject, trace: JsonObject): string {
  const resource = object(span.resource);
  const resourceAttrs = attributes(resource?.attributes ?? span.resourceAttributes ?? span.resource_attributes);
  const direct = attrText(resourceAttrs, ["service.name"]);
  if (direct) return direct;
  const processId = text(span.processID ?? span.processId ?? span.process_id);
  const process = processId ? object(object(trace.processes)?.[processId]) : undefined;
  return text(process?.serviceName ?? process?.service_name) ?? "unknown";
}

function parsedSpans(trace: JsonObject) {
  return array(trace.spans).flatMap((raw) => {
    const span = object(raw);
    if (!span) return [];
    const traceId = text(span.traceID ?? span.traceId ?? span.trace_id ?? trace.traceID ?? trace.traceId ?? trace.trace_id);
    const spanId = text(span.spanID ?? span.spanId ?? span.span_id);
    const name = text(span.operationName ?? span.operation_name ?? span.name);
    const startMicros = timestampMicros(span.startTime ?? span.start_time ?? span.startTimeUnixNano ?? span.start_time_unix_nano);
    if (!traceId || !spanId || !name || startMicros === undefined) return [];
    const attrs = attributes(span.attributes ?? span.tags);
    return [{
      raw: span,
      traceId,
      spanId,
      parentSpanId: text(span.parentSpanID ?? span.parentSpanId ?? span.parent_span_id),
      name,
      startMicros,
      durationMicros: durationMicros(span),
      attrs,
      service: serviceName(span, trace),
      status: statusFromSpan(span, attrs),
    }];
  });
}

function classifyCall(parsed: ReturnType<typeof parsedSpans>[number]): ObservabilityKind | undefined {
  if (parsed.name === "mcp.server.message") return "mcp";
  if (
    parsed.service === "ai-base-llm-gateway"
    && attrText(parsed.attrs, ["traffic.origin"]) === "internal_envoy"
    && attrText(parsed.attrs, ["mcp.method.name", "rpc.method"])
  ) return "mcp";
  if (parsed.service === "ai-base-llm-gateway" && parsed.name === "ChatCompletion") return "model";
  return undefined;
}

function safeCall(parsed: ReturnType<typeof parsedSpans>[number]): ObservabilityCall | undefined {
  const kind = classifyCall(parsed);
  if (!kind) return undefined;
  const a = parsed.attrs;
  const decisionValue = attrText(a, ["mcp.authorization.decision", "authorization.decision", "mcp.decision"]);
  const decision = decisionValue === "allow" || decisionValue === "deny" ? decisionValue : undefined;
  const requestModel = attrText(a, ["gen_ai.request.model", "llm.request.model"]);
  const responseModel = attrText(a, ["gen_ai.response.model", "llm.response.model", "llm.model_name"]);
  const method = attrText(a, ["mcp.method.name", "rpc.method"]);
  const server = attrText(a, ["mcp.server.name", "server.namespace"]);
  const tool = attrText(a, ["mcp.tool.name", "gen_ai.tool.name"]);
  return {
    traceId: parsed.traceId,
    spanId: parsed.spanId,
    kind,
    startedAt: new Date(parsed.startMicros / 1_000).toISOString(),
    durationMs: Math.round(parsed.durationMicros / 1_000),
    status: decision === "deny" ? "denied" : parsed.status,
    source: parsed.service,
    target: kind === "model" ? responseModel ?? requestModel ?? "unknown" : tool ?? server ?? "unknown",
    operation: attrText(a, ["gen_ai.operation.name"]) ?? method ?? parsed.name,
    errorType: attrText(a, ["error.type"]),
    requestModel,
    responseModel,
    provider: attrText(a, ["gen_ai.provider.name", "gen_ai.system", "llm.system"]),
    inputTokens: attrNumber(a, ["gen_ai.usage.input_tokens", "llm.token_count.prompt"]),
    outputTokens: attrNumber(a, ["gen_ai.usage.output_tokens", "llm.token_count.completion"]),
    totalTokens: attrNumber(a, ["gen_ai.usage.total_tokens", "llm.token_count.total"]),
    method,
    server,
    tool,
    action: attrText(a, ["mcp.action.name", "mcp.action", "action.name"]),
    decision,
    reason: attrText(a, ["mcp.authorization.reason", "authorization.reason"]),
    principalFingerprint: attrText(a, ["enduser.id", "mcp.principal.fingerprint"]),
    oauthClient: attrText(a, ["mcp.oauth.client_id", "oauth.client.id", "mcp.oauth.client"]),
    connection: attrText(a, ["mcp.connection.name", "connection.name"]),
  };
}

export function parseJaegerTraces(payload: unknown): JsonObject[] {
  const root = object(payload);
  const candidates = root?.traces ?? root?.data;
  const direct = array(candidates).filter((item): item is JsonObject => Boolean(object(item)));
  if (direct.length) return direct;

  // Jaeger v3 returns OTLP JSON grouped by ResourceSpans rather than trace objects.
  const grouped = new Map<string, JsonObject[]>();
  const result = object(root?.result);
  for (const rawResourceSpans of array(result?.resourceSpans ?? result?.resource_spans)) {
    const resourceSpans = object(rawResourceSpans);
    if (!resourceSpans) continue;
    const resource = resourceSpans.resource;
    for (const rawScopeSpans of array(resourceSpans.scopeSpans ?? resourceSpans.scope_spans)) {
      const scopeSpans = object(rawScopeSpans);
      for (const rawSpan of array(scopeSpans?.spans)) {
        const span = object(rawSpan);
        const traceId = text(span?.traceId ?? span?.trace_id);
        if (!span || !traceId) continue;
        const spans = grouped.get(traceId) ?? [];
        spans.push({ ...span, resource });
        grouped.set(traceId, spans);
      }
    }
  }
  return Array.from(grouped, ([traceId, spans]) => ({ traceId, spans }));
}

export function extractSafeCalls(payload: unknown): ObservabilityCall[] {
  return parseJaegerTraces(payload)
    .flatMap((trace) => parsedSpans(trace).map(safeCall))
    .filter((call): call is ObservabilityCall => Boolean(call));
}

export function extractSafeTrace(payload: unknown, traceId: string): ObservabilityTraceDetail | undefined {
  const traces = parseJaegerTraces(payload);
  const trace = traces.find((candidate) => text(candidate.traceID ?? candidate.traceId ?? candidate.trace_id) === traceId) ?? traces[0];
  if (!trace) return undefined;
  const parsed = parsedSpans(trace);
  if (!parsed.length) return undefined;
  const starts = parsed.map((span) => span.startMicros);
  const ends = parsed.map((span) => span.startMicros + span.durationMicros);
  const calls = parsed.map(safeCall).filter((call): call is ObservabilityCall => Boolean(call));
  const spans: ObservabilitySpan[] = parsed.map((span) => {
    const call = safeCall(span);
    return {
      spanId: span.spanId,
      parentSpanId: span.parentSpanId,
      name: span.name,
      serviceName: span.service,
      startedAt: new Date(span.startMicros / 1_000).toISOString(),
      durationMs: Math.round(span.durationMicros / 1_000),
      status: span.status,
      kind: call?.kind,
      target: call?.target,
      operation: call?.operation,
      errorType: call?.errorType,
      decision: call?.decision,
      reason: call?.reason,
    };
  }).sort((left, right) => left.startedAt.localeCompare(right.startedAt));
  return {
    traceId,
    startedAt: new Date(Math.min(...starts) / 1_000).toISOString(),
    durationMs: Math.round((Math.max(...ends) - Math.min(...starts)) / 1_000),
    status: spans.some((span) => span.status === "error") ? "error" : spans.some((span) => span.status === "denied") ? "denied" : "ok",
    spans,
    calls,
    jaegerUrl: protectedJaegerTraceUrl(traceId),
  };
}

function protectedJaegerTraceUrl(traceId: string): string | undefined {
  const configured = process.env.JAEGER_PUBLIC_URL?.trim();
  if (!configured) return undefined;
  try {
    const url = new URL(configured);
    if (url.protocol !== "https:") return undefined;
    url.pathname = `${url.pathname.replace(/\/$/, "")}/trace/${traceId}`;
    return url.toString();
  } catch {
    return undefined;
  }
}

async function fetchJson(url: string): Promise<unknown> {
  const response = await fetch(url, { cache: "no-store", signal: AbortSignal.timeout(FETCH_TIMEOUT_MS) });
  if (!response.ok) throw new Error(`${response.status} ${response.statusText}`);
  return response.json();
}

function rangeSeconds(range: ObservabilityRange) {
  return ({ "15m": 900, "1h": 3_600, "24h": 86_400, "7d": 604_800 })[range];
}

export function parseRange(value: string | null): ObservabilityRange {
  return value === "15m" || value === "1h" || value === "24h" || value === "7d" ? value : "1h";
}

function metricUnavailable(reason: string): MetricValue {
  return { value: null, available: false, reason };
}

function prometheusValue(payload: unknown): number | undefined {
  const data = object(object(payload)?.data);
  const first = object(array(data?.result)[0]);
  const pair = array(first?.value);
  return finite(pair[1]);
}

const metricQueries = {
  modelCalls: (range: string) => `sum(increase(gen_ai_server_request_duration_seconds_count{otel_scope_name="envoyproxy/ai-gateway",traffic_origin!="management_probe"}[${range}]))`,
  modelP95: (range: string) => `histogram_quantile(0.95,sum by (le) (rate(gen_ai_server_request_duration_seconds_bucket{otel_scope_name="envoyproxy/ai-gateway",traffic_origin!="management_probe"}[${range}]))) * 1000`,
  modelInputTokens: (range: string) => `sum(increase(gen_ai_client_token_usage_sum{otel_scope_name="envoyproxy/ai-gateway",traffic_origin!="management_probe",gen_ai_token_type="input"}[${range}]))`,
  modelOutputTokens: (range: string) => `sum(increase(gen_ai_client_token_usage_sum{otel_scope_name="envoyproxy/ai-gateway",traffic_origin!="management_probe",gen_ai_token_type="output"}[${range}]))`,
  mcpCalls: (range: string) => `sum(increase(mcp_duration_milliseconds_count{span_name="mcp.server.message",traffic_origin!="management_probe"}[${range}]))`,
  mcpDenied: (range: string) => `sum(increase(mcp_duration_milliseconds_count{span_name="mcp.server.message",traffic_origin!="management_probe",mcp_decision="deny"}[${range}])) / clamp_min(sum(increase(mcp_duration_milliseconds_count{span_name="mcp.server.message",traffic_origin!="management_probe"}[${range}])),1)`,
  mcpErrors: (range: string) => `sum(increase(mcp_duration_milliseconds_count{span_name="mcp.server.message",traffic_origin!="management_probe",mcp_result=~"error|upstream_unavailable|http_error"}[${range}])) / clamp_min(sum(increase(mcp_duration_milliseconds_count{span_name="mcp.server.message",traffic_origin!="management_probe"}[${range}])),1)`,
  mcpP95: (range: string) => `histogram_quantile(0.95,sum by (le) (rate(mcp_duration_milliseconds_bucket{span_name="mcp.server.message",traffic_origin!="management_probe"}[${range}])))`,
} as const;

export async function getObservabilitySummary(range: ObservabilityRange): Promise<ObservabilitySummary> {
  const key = range;
  const cached = summaryCache.get(key);
  if (cached && cached.expiresAt > Date.now()) return cached.value;
  const base = process.env.PROMETHEUS_URL || "http://prometheus:9090";
  const promRange = `${rangeSeconds(range)}s`;
  const entries = await Promise.all(Object.entries(metricQueries).map(async ([name, query]) => {
    try {
      const url = new URL("/api/v1/query", base);
      url.searchParams.set("query", query(promRange));
      const value = prometheusValue(await fetchJson(url.toString()));
      return [name, value === undefined ? metricUnavailable("指标尚未产生") : { value, available: true }] as const;
    } catch {
      return [name, metricUnavailable("Prometheus 查询不可用")] as const;
    }
  }));
  const metrics = Object.fromEntries(entries) as Record<keyof typeof metricQueries, MetricValue>;
  const availableCount = entries.filter(([, metric]) => metric.available).length;
  const partial = availableCount !== entries.length;
  const value: ObservabilitySummary = {
    generatedAt: new Date().toISOString(),
    range,
    partial,
    sources: {
      metrics: availableCount === 0 ? "offline" : partial ? "partial" : "healthy",
      message: partial ? "部分规范指标尚未产生或查询超时。" : undefined,
    },
    model: {
      calls: metrics.modelCalls,
      errorRate: metricUnavailable("当前 capability probe 未证明模型错误率指标"),
      p95LatencyMs: metrics.modelP95,
      inputTokens: metrics.modelInputTokens,
      outputTokens: metrics.modelOutputTokens,
      ttftP95Ms: metricUnavailable("当前 capability probe 未证明 TTFT 指标"),
    },
    mcp: {
      calls: metrics.mcpCalls,
      deniedRate: metrics.mcpDenied,
      errorRate: metrics.mcpErrors,
      p95LatencyMs: metrics.mcpP95,
    },
  };
  summaryCache.set(key, { expiresAt: Date.now() + CACHE_TTL_MS, value });
  return value;
}

function parseDate(value: string | null, fallback: number) {
  if (!value) return fallback;
  const parsed = Date.parse(value);
  if (!Number.isFinite(parsed)) throw new ObservabilityRequestError("时间格式无效");
  return parsed;
}

export function parseCallQuery(searchParams: URLSearchParams, now = Date.now()) {
  const kindValue = searchParams.get("kind");
  if (kindValue !== "model" && kindValue !== "mcp") throw new ObservabilityRequestError("kind 必须是 model 或 mcp");
  const kind: ObservabilityKind = kindValue;
  const to = parseDate(searchParams.get("to"), now);
  const from = parseDate(searchParams.get("from"), to - 60 * 60 * 1_000);
  if (to <= from || to - from > MAX_TRACE_SEARCH_WINDOW_MS) throw new ObservabilityRequestError("诊断样本时间窗必须大于 0 且不超过 24 小时");
  const requestedLimit = finite(searchParams.get("limit")) ?? 50;
  const limit = Math.max(1, Math.min(MAX_TRACE_SEARCH_RESULTS, Math.floor(requestedLimit)));
  const status = searchParams.get("status");
  if (status && status !== "ok" && status !== "error" && status !== "denied") throw new ObservabilityRequestError("status 筛选无效");
  const target = searchParams.get("target")?.trim();
  if (target && target.length > 128) throw new ObservabilityRequestError("target 筛选过长");
  return { kind, from, to, limit, status: status as ObservabilityStatus | null, target };
}

function jaegerSearchUrl(from: number, to: number) {
  const base = process.env.JAEGER_URL || "http://jaeger:16686";
  const url = new URL(`${base.replace(/\/$/, "")}/api/v3/traces`);
  url.searchParams.set("query.startTimeMin", new Date(from).toISOString());
  url.searchParams.set("query.startTimeMax", new Date(to).toISOString());
  url.searchParams.set("query.numTraces", String(MAX_TRACE_SEARCH_RESULTS));
  return url.toString();
}

export async function getObservabilityCalls(searchParams: URLSearchParams): Promise<ObservabilityCallsResult> {
  const query = parseCallQuery(searchParams);
  const cacheKey = [query.kind, query.from, query.to, query.limit, query.status ?? "", query.target ?? ""].join(":");
  const cached = callsCache.get(cacheKey);
  if (cached && cached.expiresAt > Date.now()) return cached.value;
  try {
    const payload = await fetchJson(jaegerSearchUrl(query.from, query.to));
    const traces = parseJaegerTraces(payload);
    const matching = extractSafeCalls(payload)
      .filter((call) => call.kind === query.kind)
      .filter((call) => !query.status || call.status === query.status)
      .filter((call) => !query.target || call.target === query.target)
      .sort((left, right) => right.startedAt.localeCompare(left.startedAt));
    const result: ObservabilityCallsResult = {
      items: matching.slice(0, query.limit),
      kind: query.kind,
      scannedTraces: traces.length,
      truncated: traces.length >= MAX_TRACE_SEARCH_RESULTS || matching.length > query.limit,
      window: { from: new Date(query.from).toISOString(), to: new Date(query.to).toISOString() },
      source: "healthy",
    };
    callsCache.set(cacheKey, { expiresAt: Date.now() + CACHE_TTL_MS, value: result });
    return result;
  } catch (error) {
    if (error instanceof ObservabilityRequestError) throw error;
    return {
      items: [], kind: query.kind, scannedTraces: 0, truncated: false,
      window: { from: new Date(query.from).toISOString(), to: new Date(query.to).toISOString() },
      source: "offline", message: "Jaeger 查询超时或不可用。",
    };
  }
}

export function validateTraceId(value: string) {
  if (!/^[a-f0-9]{16,32}$/i.test(value)) throw new ObservabilityRequestError("Trace ID 格式无效");
  return value.toLowerCase();
}

export async function getObservabilityTrace(traceIdInput: string): Promise<ObservabilityTraceDetail | undefined> {
  const traceId = validateTraceId(traceIdInput);
  const cached = traceCache.get(traceId);
  if (cached && cached.expiresAt > Date.now()) return cached.value;
  const base = process.env.JAEGER_URL || "http://jaeger:16686";
  const url = new URL(`${base.replace(/\/$/, "")}/api/v3/traces/${traceId}`);
  const payload = await fetchJson(url.toString());
  const result = extractSafeTrace(payload, traceId);
  traceCache.set(traceId, { expiresAt: Date.now() + CACHE_TTL_MS, value: result });
  return result;
}

export function resetObservabilityCacheForTests() {
  summaryCache.clear();
  callsCache.clear();
  traceCache.clear();
}
