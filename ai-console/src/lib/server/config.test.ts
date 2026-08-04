import { mkdtemp, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

import { describe, expect, it } from "vitest";

import {
  applyConfigPatch,
  createDefaultConfig,
  getWeComAuthenticationSnapshot,
  readConfig,
  updateWeComAuthenticationSettings,
  validateConfigPatch,
  validateWeComAuthenticationSettings,
} from "./config";

describe("config validation", () => {
  it("accepts and applies an allow-listed nested patch", () => {
    const validation = validateConfigPatch({
      environment: "staging",
      monthlyBudget: 2_500,
      services: { "llm-gateway": { enabled: false, notes: "maintenance" } },
    });
    expect(validation.ok).toBe(true);
    if (!validation.ok) return;

    const result = applyConfigPatch(
      createDefaultConfig(new Date("2026-01-01T00:00:00.000Z")),
      validation.value,
      new Date("2026-01-02T00:00:00.000Z"),
    );
    expect(result.environment).toBe("staging");
    expect(result.services["llm-gateway"]).toEqual({
      enabled: false,
      notes: "maintenance",
    });
    expect(result.updatedAt).toBe("2026-01-02T00:00:00.000Z");
  });

  it("rejects unsupported and invalid fields", () => {
    const validation = validateConfigPatch({
      updatedAt: "forged",
      monthlyBudget: -1,
      services: {
        postgres: { enabled: "yes", password: "secret" },
        unknown: { enabled: true },
      },
    });
    expect(validation.ok).toBe(false);
    if (validation.ok) return;
    expect(validation.errors).toEqual(expect.arrayContaining([
      "unsupported field: updatedAt",
      "monthlyBudget must be between 0 and 1000000000",
      "services.postgres.enabled must be a boolean",
      "unsupported field: services.postgres.password",
      "unknown service: unknown",
    ]));
  });
});

describe("WeCom authentication settings", () => {
  it("normalizes an administrator-managed relay configuration", () => {
    const validation = validateWeComAuthenticationSettings({
      publicBaseUrl: "https://ai.example.com/wecom-oidc/",
      callbackMode: "relay",
      relayCallbackUrl: "https://tn1.cofly-ai.cn/callbacks/wecom",
      emailDomain: "Example.COM",
    });
    expect(validation).toEqual({
      ok: true,
      value: {
        publicBaseUrl: "https://ai.example.com/wecom-oidc",
        callbackMode: "relay",
        relayCallbackUrl: "https://tn1.cofly-ai.cn/callbacks/wecom",
        emailDomain: "example.com",
      },
    });
    if (!validation.ok) return;
    const snapshot = getWeComAuthenticationSnapshot({
      ...createDefaultConfig(new Date("2026-08-04T00:00:00.000Z")),
      authentication: { wecom: validation.value },
    });
    expect(snapshot.effectiveCallbackUrl).toBe("https://tn1.cofly-ai.cn/callbacks/wecom");
  });

  it("rejects unsafe callback URLs and invalid email domains", () => {
    const validation = validateWeComAuthenticationSettings({
      publicBaseUrl: "https://user:pass@ai.example.com/wecom-oidc",
      callbackMode: "relay",
      relayCallbackUrl: "http://tn1.cofly-ai.cn/callbacks/wecom?target=attacker",
      emailDomain: "https://example.com",
    });
    expect(validation.ok).toBe(false);
    if (validation.ok) return;
    expect(validation.errors).toEqual(expect.arrayContaining([
      "AI Base 公开认证入口必须是绝对 HTTP(S) 地址，且不能包含账号、查询参数或片段",
      "公网中继回调地址必须是绝对 HTTP(S) 地址，且不能包含账号、查询参数或片段",
      "企业邮箱域必须是有效的 DNS 域名",
    ]));
  });

  it("persists settings without environment-variable fallback", async () => {
    const directory = await mkdtemp(path.join(tmpdir(), "ai-console-config-"));
    const previousDirectory = process.env.AI_CONSOLE_DATA_DIR;
    process.env.AI_CONSOLE_DATA_DIR = directory;
    try {
      const snapshot = await updateWeComAuthenticationSettings({
        publicBaseUrl: "http://127.0.0.1:8080/wecom-oidc",
        callbackMode: "direct",
        emailDomain: "example.com",
      });
      expect(snapshot.effectiveCallbackUrl).toBe("http://127.0.0.1:8080/wecom-oidc/callback");
      expect((await readConfig()).authentication.wecom.emailDomain).toBe("example.com");
    } finally {
      if (previousDirectory === undefined) delete process.env.AI_CONSOLE_DATA_DIR;
      else process.env.AI_CONSOLE_DATA_DIR = previousDirectory;
      await rm(directory, { recursive: true, force: true });
    }
  });
});

describe("config storage", () => {
  it("creates the default JSON config without leaving a temporary file", async () => {
    const directory = await mkdtemp(path.join(tmpdir(), "ai-console-config-"));
    const previousDirectory = process.env.AI_CONSOLE_DATA_DIR;
    process.env.AI_CONSOLE_DATA_DIR = directory;

    try {
      const config = await readConfig();
      const persisted = JSON.parse(
        await readFile(path.join(directory, "config.json"), "utf8"),
      );
      expect(persisted).toEqual(config);
      expect(await readdir(directory)).toEqual(["config.json"]);
      expect(await readConfig()).toEqual(config);
    } finally {
      if (previousDirectory === undefined) delete process.env.AI_CONSOLE_DATA_DIR;
      else process.env.AI_CONSOLE_DATA_DIR = previousDirectory;
      await rm(directory, { recursive: true, force: true });
    }
  });

  it("migrates the legacy Bifrost service key", async () => {
    const directory = await mkdtemp(path.join(tmpdir(), "ai-console-config-"));
    const previousDirectory = process.env.AI_CONSOLE_DATA_DIR;
    process.env.AI_CONSOLE_DATA_DIR = directory;

    try {
      const legacy = createDefaultConfig(new Date("2026-01-01T00:00:00.000Z"));
      await writeFile(path.join(directory, "config.json"), JSON.stringify({
        ...legacy,
        authentication: undefined,
        services: { bifrost: { enabled: false, notes: "legacy" } },
      }), "utf8");
      const config = await readConfig();
      expect(config.services["llm-gateway"]).toEqual({ enabled: false, notes: "legacy" });
      expect("bifrost" in config.services).toBe(false);
      expect(config.authentication.wecom).toEqual({
        publicBaseUrl: "http://127.0.0.1:8080/wecom-oidc",
        callbackMode: "direct",
        emailDomain: "bluetron.cn",
      });
    } finally {
      if (previousDirectory === undefined) delete process.env.AI_CONSOLE_DATA_DIR;
      else process.env.AI_CONSOLE_DATA_DIR = previousDirectory;
      await rm(directory, { recursive: true, force: true });
    }
  });
});
