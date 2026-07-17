import { describe, expect, it } from "vitest";

import { serviceById } from "../control-plane/catalog";
import { createDefaultConfig } from "./config";
import { checkService, resolveHttpEndpoint, resolveTcpTarget } from "./services";

describe("service target resolution", () => {
  it("prefers config, then environment, then the catalog default", () => {
    expect(resolveHttpEndpoint(serviceById["llm-gateway"], { enabled: true }, {
      LLM_GATEWAY_URL: "http://gateway.internal",
    })).toBe("http://gateway.internal");
    expect(resolveHttpEndpoint(serviceById["llm-gateway"], {
      enabled: true,
      endpoint: "http://configured.internal",
    }, {})).toBe("http://configured.internal");
    expect(resolveHttpEndpoint(serviceById["llm-gateway"], { enabled: true }, {})).toBe(
      "http://localhost:8080",
    );
  });

  it("resolves postgres targets from URLs and environment", () => {
    expect(resolveTcpTarget(serviceById.postgres, {
      enabled: true,
      endpoint: "postgresql://db.internal:6432/app",
    }, {})).toEqual({ host: "db.internal", port: 6432 });
    expect(resolveTcpTarget(serviceById.postgres, { enabled: true }, {
      POSTGRES_HOST: "postgres",
      POSTGRES_PORT: "5433",
    })).toEqual({ host: "postgres", port: 5433 });
  });

  it("reports the CI-managed Promptfoo service as idle", async () => {
    const snapshot = await checkService(
      serviceById.promptfoo,
      createDefaultConfig(new Date("2026-01-01T00:00:00.000Z")),
    );
    expect(snapshot.status).toBe("idle");
    expect(snapshot.detail).toContain("CI");
  });

  it("reports disabled services as unconfigured", async () => {
    const config = createDefaultConfig(new Date("2026-01-01T00:00:00.000Z"));
    config.services.promptfoo = { enabled: false };
    const snapshot = await checkService(
      serviceById.promptfoo,
      config,
    );
    expect(snapshot.status).toBe("unconfigured");
  });
});
