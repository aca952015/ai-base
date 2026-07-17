import { describe, expect, it } from "vitest";

import { summarizeJaegerTrace } from "./component-data";

describe("component data adapters", () => {
  it("reduces Jaeger spans to a safe trace summary", () => {
    const result = summarizeJaegerTrace({
      traceID: "trace-1",
      processes: { p1: { serviceName: "agent-runtime" } },
      spans: [
        {
          operationName: "POST /runs",
          processID: "p1",
          startTime: 1_000_000,
          duration: 50_000,
          tags: [{ key: "http.status_code", value: 201 }],
        },
        {
          operationName: "model.call",
          processID: "p1",
          startTime: 1_010_000,
          duration: 100_000,
          tags: [],
        },
      ],
    });

    expect(result).toMatchObject({
      traceId: "trace-1",
      serviceName: "agent-runtime",
      operationName: "POST /runs",
      spanCount: 2,
      durationMs: 110,
      status: "healthy",
    });
  });

  it("marks HTTP failures without exposing arbitrary span fields", () => {
    const result = summarizeJaegerTrace({
      traceID: "trace-2",
      spans: [{
        operationName: "GET /health",
        startTime: 2_000_000,
        duration: 2_000,
        tags: [{ key: "http.status_code", value: 503 }],
      }],
    });

    expect(result?.status).toBe("degraded");
    expect(result).not.toHaveProperty("tags");
  });

  it("ignores malformed traces without spans", () => {
    expect(summarizeJaegerTrace({ traceID: "trace-3", spans: [] })).toBeUndefined();
  });
});
