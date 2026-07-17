import { access, mkdtemp, readFile, rm } from "node:fs/promises";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import path from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import type { GatewayChannel, GatewayChannelDraft } from "../control-plane/gateway";
import {
  generateGatewayConfig,
  getGatewayConfigPaths,
  readGatewayChannels,
  saveGatewayChannels,
  testGatewayChannel,
  validateGatewayChannelsInput,
} from "./gateway-config";

const temporaryDirectories: string[] = [];
const originalDataDirectory = process.env.AI_CONSOLE_DATA_DIR;

async function useTemporaryDataDirectory() {
  const directory = await mkdtemp(path.join(tmpdir(), "ai-console-gateway-"));
  temporaryDirectories.push(directory);
  process.env.AI_CONSOLE_DATA_DIR = directory;
  return directory;
}

afterEach(async () => {
  if (originalDataDirectory === undefined) delete process.env.AI_CONSOLE_DATA_DIR;
  else process.env.AI_CONSOLE_DATA_DIR = originalDataDirectory;
  await Promise.all(temporaryDirectories.splice(0).map((directory) => rm(directory, { recursive: true, force: true })));
});

function draft(overrides: Partial<GatewayChannelDraft> = {}): GatewayChannelDraft {
  return {
    id: "channel-openai",
    name: "OpenAI",
    provider: "openai",
    baseUrl: "https://api.openai.com/v1",
    enabled: true,
    models: [{ publicName: "chat-fast", upstreamName: "gpt-4.1-mini" }],
    apiKey: "test-secret",
    ...overrides,
  };
}

describe("gateway channel validation", () => {
  it("accepts allow-listed providers and rejects ambiguous published model routes", () => {
    const validation = validateGatewayChannelsInput({
      channels: [
        draft(),
        draft({ id: "channel-anthropic", name: "Anthropic", provider: "anthropic", baseUrl: "https://api.anthropic.com/v1" }),
      ],
    });
    expect(validation.ok).toBe(false);
    if (validation.ok) return;
    expect(validation.errors).toContain("published model chat-fast is configured by more than one enabled channel");
  });

  it("normalizes safe base URLs and model mappings", () => {
    const validation = validateGatewayChannelsInput({ channels: [draft({ baseUrl: "https://api.openai.com/v1/" })] });
    expect(validation.ok).toBe(true);
    if (!validation.ok) return;
    expect(validation.value[0].baseUrl).toBe("https://api.openai.com/v1");
    expect(validation.value[0].models[0]).toEqual({ publicName: "chat-fast", upstreamName: "gpt-4.1-mini" });
  });

  it("allows an empty model list for a disabled discovery draft", () => {
    const validation = validateGatewayChannelsInput({
      channels: [draft({ enabled: false, models: [] })],
    });
    expect(validation.ok).toBe(true);
  });
});

describe("Envoy gateway config generation", () => {
  it("uses native provider resources, file-backed secrets, and no MCP route", () => {
    const channel: GatewayChannel = {
      ...draft(),
      keyConfigured: true,
      createdAt: "2026-07-17T00:00:00.000Z",
      updatedAt: "2026-07-17T00:00:00.000Z",
    };
    const config = generateGatewayConfig([channel]);
    expect(config).toContain("kind: AIGatewayRoute");
    expect(config).toContain('value: "chat-fast"');
    expect(config).toContain('modelNameOverride: "gpt-4.1-mini"');
    expect(config).toContain('fqdn:\n        hostname: "api.openai.com"\n        port: 443');
    expect(config).toContain("substitution.aigw.run/file/apiKey");
    expect(config).not.toContain("test-secret");
    expect(config).not.toContain("kind: MCPRoute");
  });
});

describe("gateway channel storage", () => {
  it("persists secrets separately and never returns their value", async () => {
    await useTemporaryDataDirectory();
    const saved = await saveGatewayChannels([draft()], new Date("2026-07-17T08:00:00.000Z"));
    expect(saved.channels[0].keyConfigured).toBe(true);
    expect(saved.channels[0]).not.toHaveProperty("apiKey");

    const paths = getGatewayConfigPaths();
    expect(await readFile(path.join(paths.secrets, "channel-openai.key"), "utf8")).toBe("test-secret");
    expect(await readFile(paths.config, "utf8")).not.toContain("test-secret");
    expect((await readGatewayChannels()).channels[0].keyConfigured).toBe(true);
  });

  it("removes generated config when all channels are removed", async () => {
    await useTemporaryDataDirectory();
    await saveGatewayChannels([draft()]);
    const paths = getGatewayConfigPaths();
    await saveGatewayChannels([]);
    await expect(access(paths.config)).rejects.toThrow();
    await expect(access(path.join(paths.secrets, "channel-openai.key"))).rejects.toThrow();
  });
});

describe("gateway channel connectivity test", () => {
  it("calls the provider models endpoint with a server-side bearer key", async () => {
    let authorization = "";
    const server = createServer((request, response) => {
      authorization = request.headers.authorization || "";
      response.setHeader("content-type", "application/json");
      response.end(JSON.stringify({ data: [{ id: "model-a" }] }));
    });
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    const address = server.address();
    if (!address || typeof address === "string") throw new Error("missing test server address");
    try {
      const result = await testGatewayChannel(draft({ baseUrl: `http://127.0.0.1:${address.port}/v1` }));
      expect(result).toMatchObject({ ok: true, discoveredModels: ["model-a"] });
      expect(authorization).toBe("Bearer test-secret");
    } finally {
      await new Promise<void>((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
    }
  });
});
