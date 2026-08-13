import { afterEach, describe, expect, it, vi } from "vitest";

import {
  extractSafeCalls,
  extractSafeTrace,
  getObservabilityCalls,
  getObservabilitySummary,
  parseCallQuery,
  resetObservabilityCacheForTests,
} from "./observability";

function attribute(key: string, value: unknown) {
  return { key, value: typeof value === "number" ? { intValue: String(value) } : { stringValue: value } };
}

function trace(index = 1) {
  const traceId = index.toString(16).padStart(32, "0");
  return {
    trace_id: traceId,
    spans: [{
      trace_id: traceId,
      span_id: index.toString(16).padStart(16, "0"),
      operation_name: "ChatCompletion",
      start_time: "2026-08-10T08:00:00.000Z",
      duration_micros: 125_000,
      resource: { attributes: [attribute("service.name", "ai-base-llm-gateway")] },
      attributes: [
        attribute("gen_ai.operation.name", "chat"),
        attribute("gen_ai.request.model", index % 2 ? "safe-model" : "other-model"),
        attribute("gen_ai.response.model", "provider-model"),
        attribute("llm.token_count.prompt", 7),
        attribute("llm.token_count.completion", 3),
        attribute("llm.token_count.total", 10),
        attribute("gen_ai.input.messages", "SENTINEL_SECRET"),
        attribute("authorization", "Bearer secret"),
      ],
      events: [{ name: "exception", attributes: [attribute("exception.message", "SENTINEL_SECRET")] }],
    }],
  };
}

function jaegerV3Payload(value = trace()) {
  const span = value.spans[0];
  return {
    result: {
      resourceSpans: [{
        resource: span.resource,
        scopeSpans: [{ spans: [{ ...span, resource: undefined }] }],
      }],
    },
  };
}

afterEach(() => {
  vi.restoreAllMocks();
  resetObservabilityCacheForTests();
  delete process.env.JAEGER_PUBLIC_URL;
});

describe("observability safe adapters", () => {
  it("parses the verified Jaeger v3-style fixture and only emits allow-listed fields", () => {
    const calls = extractSafeCalls(jaegerV3Payload());
    expect(calls).toEqual([expect.objectContaining({
      kind: "model",
      target: "provider-model",
      requestModel: "safe-model",
      totalTokens: 10,
      durationMs: 125,
    })]);
    const serialized = JSON.stringify(calls);
    expect(serialized).not.toContain("SENTINEL_SECRET");
    expect(serialized).not.toContain("authorization");
    expect(serialized).not.toContain("events");
    expect(serialized).not.toContain("attributes");
  });

  it("accepts the OpenInference aliases emitted by the pinned model gateway", () => {
    const payload = jaegerV3Payload(trace());
    const span = payload.result.resourceSpans[0].scopeSpans[0].spans[0];
    span.attributes = [
      attribute("llm.model_name", "resolved-model"),
      attribute("llm.system", "openai"),
      attribute("traffic.origin", "external_gateway"),
    ];

    expect(extractSafeCalls(payload)).toMatchObject([{
      kind: "model",
      target: "resolved-model",
      responseModel: "resolved-model",
      provider: "openai",
    }]);
  });

  it("ignores malformed traces and spans", () => {
    expect(extractSafeCalls({ traces: [{ trace_id: "missing-spans" }, { spans: [{}] }, null] })).toEqual([]);
    expect(extractSafeTrace({ traces: [{ spans: [{}] }] }, "abc")).toBeUndefined();
  });

  it("only emits canonical model and MCP call spans", () => {
    const gatewayModel = trace();
    const traceId = gatewayModel.trace_id;
    const payload = {
      traces: [{
        trace_id: traceId,
        spans: [
          gatewayModel.spans[0],
          {
            ...gatewayModel.spans[0],
            span_id: "2".padStart(16, "0"),
            operation_name: "chat model",
            resource: { attributes: [attribute("service.name", "ai-base-agent-runtime")] },
          },
          {
            ...gatewayModel.spans[0],
            span_id: "3".padStart(16, "0"),
            operation_name: "mcp.server.message",
            resource: { attributes: [attribute("service.name", "ai-base-mcp-access-gateway")] },
            attributes: [attribute("mcp.method.name", "tools/list")],
          },
          {
            ...gatewayModel.spans[0],
            span_id: "4".padStart(16, "0"),
            operation_name: "POST",
            resource: { attributes: [attribute("service.name", "ai-base-llm-gateway")] },
            attributes: [
              attribute("mcp.method.name", "tools/list"),
              attribute("traffic.origin", "public_mcp_gateway"),
            ],
          },
          {
            ...gatewayModel.spans[0],
            span_id: "5".padStart(16, "0"),
            operation_name: "MCPRequest",
            resource: { attributes: [attribute("service.name", "ai-base-llm-gateway")] },
            attributes: [
              attribute("mcp.method.name", "resources/read"),
              attribute("traffic.origin", "internal_envoy"),
            ],
          },
        ],
      }],
    };

    expect(extractSafeCalls(payload).map(({ kind, spanId }) => ({ kind, spanId }))).toEqual([
      { kind: "model", spanId: gatewayModel.spans[0].span_id },
      { kind: "mcp", spanId: "3".padStart(16, "0") },
      { kind: "mcp", spanId: "5".padStart(16, "0") },
    ]);
  });

  it("only creates a deep link for an explicitly configured HTTPS Jaeger URL", () => {
    process.env.JAEGER_PUBLIC_URL = "http://jaeger:16686";
    expect(extractSafeTrace({ traces: [trace()] }, "a".repeat(32))?.jaegerUrl).toBeUndefined();
    process.env.JAEGER_PUBLIC_URL = "https://jaeger.example.test/base";
    expect(extractSafeTrace({ traces: [trace()] }, "a".repeat(32))?.jaegerUrl)
      .toBe(`https://jaeger.example.test/base/trace/${"a".repeat(32)}`);
  });
});

describe("observability queries", () => {
  it("rejects windows over 24 hours and clamps the sample limit", () => {
    expect(() => parseCallQuery(new URLSearchParams({ kind: "mcp", from: "2026-08-01", to: "2026-08-03" }))).toThrow(/24/);
    expect(parseCallQuery(new URLSearchParams({ kind: "model", limit: "999" }), Date.parse("2026-08-10T09:00:00Z")).limit).toBe(100);
  });

  it("applies fixed filters and marks a 100-trace diagnostic sample truncated", async () => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(new Response(JSON.stringify({ traces: Array.from({ length: 100 }, (_, index) => trace(index + 1)) }), { status: 200 })));
    const result = await getObservabilityCalls(new URLSearchParams({
      kind: "model", target: "provider-model", status: "ok", limit: "5",
      from: "2026-08-10T07:00:00Z", to: "2026-08-10T09:00:00Z",
    }));
    expect(result.items).toHaveLength(5);
    expect(result.scannedTraces).toBe(100);
    expect(result.truncated).toBe(true);
    expect(result.items.every((item) => item.target === "provider-model" && item.status === "ok")).toBe(true);
  });

  it("returns an honest offline result when Jaeger times out", async () => {
    vi.stubGlobal("fetch", vi.fn().mockRejectedValue(new DOMException("timeout", "TimeoutError")));
    const result = await getObservabilityCalls(new URLSearchParams({ kind: "mcp" }));
    expect(result).toMatchObject({ source: "offline", items: [], scannedTraces: 0, truncated: false });
  });

  it("keeps successful Prometheus metrics when other fixed queries fail", async () => {
    let call = 0;
    vi.stubGlobal("fetch", vi.fn().mockImplementation(() => {
      call += 1;
      return call === 1
        ? Promise.resolve(new Response(JSON.stringify({ status: "success", data: { result: [{ value: [0, "12"] }] } }), { status: 200 }))
        : Promise.reject(new Error("offline"));
    }));
    const result = await getObservabilitySummary("1h");
    expect(result.model.calls).toEqual({ value: 12, available: true });
    expect(result.model.p95LatencyMs.available).toBe(false);
    expect(result.sources.metrics).toBe("partial");
    expect(result.partial).toBe(true);
    expect(result.model.errorRate.reason).toMatch(/capability probe/);
    expect(result.model.ttftP95Ms.reason).toMatch(/capability probe/);
  });

  it("excludes management probes from every canonical model metric", async () => {
    const queries: string[] = [];
    vi.stubGlobal("fetch", vi.fn().mockImplementation((input: string | URL | Request) => {
      const url = new URL(input instanceof Request ? input.url : input.toString());
      queries.push(url.searchParams.get("query") || "");
      return Promise.resolve(new Response(JSON.stringify({
        status: "success",
        data: { result: [{ value: [0, "1"] }] },
      }), { status: 200 }));
    }));

    await getObservabilitySummary("15m");

    const modelQueries = queries.filter((query) => query.includes("gen_ai_"));
    expect(modelQueries).toHaveLength(4);
    expect(modelQueries.every((query) => query.includes('traffic_origin!="management_probe"'))).toBe(true);
    expect(modelQueries.some((query) => query.includes("request_duration_seconds_count"))).toBe(true);
    expect(modelQueries.some((query) => query.includes("request_duration_seconds_bucket"))).toBe(true);
    expect(modelQueries.some((query) => query.includes('gen_ai_token_type="input"'))).toBe(true);
    expect(modelQueries.some((query) => query.includes('gen_ai_token_type="output"'))).toBe(true);
  });

  it("counts MCP errors only from the sealed upstream and protocol result codes", async () => {
    const queries: string[] = [];
    vi.stubGlobal("fetch", vi.fn().mockImplementation((input: string | URL | Request) => {
      const url = new URL(input instanceof Request ? input.url : input.toString());
      queries.push(url.searchParams.get("query") || "");
      return Promise.resolve(new Response(JSON.stringify({
        status: "success",
        data: { result: [{ value: [0, "1"] }] },
      }), { status: 200 }));
    }));

    await getObservabilitySummary("1h");

    const errorQuery = queries.find((query) => query.includes('mcp_result=~'));
    expect(errorQuery).toContain('mcp_result=~"error|upstream_unavailable|http_error"');
    expect(errorQuery).toContain('traffic_origin!="management_probe"');
    expect(errorQuery).not.toContain("status_code");
    expect(errorQuery).not.toContain("authentication_failed");
    expect(errorQuery).not.toContain("session_rejected");
    expect(errorQuery).not.toContain("denied");
  });
});
