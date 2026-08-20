import { access, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import path from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import type { GatewayChannel, GatewayChannelDraft } from "../control-plane/gateway";
import type { GatewayMcpServer, GatewayMcpServerDraft } from "../control-plane/mcp";
import {
  generateGatewayConfig,
  getGatewayConfigPaths,
  readGatewayChannels,
  readGatewayMcpServers,
  saveGatewayChannels,
  saveGatewayMcpServers,
  testGatewayChannel,
  testGatewayMcpServer,
  validateGatewayChannelsInput,
  validateGatewayMcpServersInput,
} from "./gateway-config";

const temporaryDirectories: string[] = [];
const originalDataDirectory = process.env.AI_CONSOLE_DATA_DIR;
const originalOpenConnectorRuntimeToken = process.env.OPEN_CONNECTOR_RUNTIME_TOKEN;
const originalLightRagApiKey = process.env.LIGHTRAG_API_KEY;

async function useTemporaryDataDirectory() {
  const directory = await mkdtemp(path.join(tmpdir(), "ai-console-gateway-"));
  temporaryDirectories.push(directory);
  process.env.AI_CONSOLE_DATA_DIR = directory;
  return directory;
}

afterEach(async () => {
  if (originalDataDirectory === undefined) delete process.env.AI_CONSOLE_DATA_DIR;
  else process.env.AI_CONSOLE_DATA_DIR = originalDataDirectory;
  if (originalOpenConnectorRuntimeToken === undefined) delete process.env.OPEN_CONNECTOR_RUNTIME_TOKEN;
  else process.env.OPEN_CONNECTOR_RUNTIME_TOKEN = originalOpenConnectorRuntimeToken;
  if (originalLightRagApiKey === undefined) delete process.env.LIGHTRAG_API_KEY;
  else process.env.LIGHTRAG_API_KEY = originalLightRagApiKey;
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

function mcpDraft(overrides: Partial<GatewayMcpServerDraft> = {}): GatewayMcpServerDraft {
  return {
    id: "mcp-github",
    name: "GitHub MCP",
    namespace: "github",
    url: "https://api.githubcopilot.com/mcp/readonly",
    enabled: true,
    authHeader: "Authorization",
    toolIncludes: ["issue_read"],
    toolExcludes: ["delete_repository"],
    apiKey: "super-private-token",
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

  it("adds MCPRoute backends, tool filters, and file-backed MCP secrets", () => {
    const server: GatewayMcpServer = {
      ...mcpDraft(),
      managed: false,
      keyConfigured: true,
      createdAt: "2026-07-20T00:00:00.000Z",
      updatedAt: "2026-07-20T00:00:00.000Z",
    };
    const config = generateGatewayConfig([], [server]);
    expect(config).toContain("kind: MCPRoute");
    expect(config).toContain('path: "/mcp"');
    expect(config).toContain('hostname: "mcp-backend-adapter"');
    expect(config).toContain('path: "/internal/v1/mcp-backends/github"');
    expect(config).not.toContain('hostname: "api.githubcopilot.com"');
    expect(config).toContain('          - "issue_read"');
    expect(config).toContain('          - "delete_repository"');
    expect(config).toContain("substitution.aigw.run/file/apiKey");
    expect(config).not.toContain("super-private-token");
  });
});

describe("gateway MCP validation", () => {
  it("preserves a root MCP endpoint instead of appending an /mcp path", () => {
    const validation = validateGatewayMcpServersInput({
      servers: [mcpDraft({ url: "https://mcp.example.com" })],
    });
    expect(validation.ok).toBe(true);
    if (!validation.ok) return;
    expect(validation.value[0].url).toBe("https://mcp.example.com");

    const server: GatewayMcpServer = {
      ...validation.value[0],
      managed: false,
      keyConfigured: false,
      createdAt: "2026-07-20T00:00:00.000Z",
      updatedAt: "2026-07-20T00:00:00.000Z",
    };
    const config = generateGatewayConfig([], [server]);
    expect(config).toContain('path: "/internal/v1/mcp-backends/github"');
    expect(config).not.toContain('path: "/mcp/mcp"');
  });

  it("normalizes MCP URLs and rejects duplicate tool namespaces", () => {
    const validation = validateGatewayMcpServersInput({
      servers: [
        mcpDraft({ url: "https://example.com/mcp/" }),
        mcpDraft({ id: "mcp-second", name: "Second" }),
      ],
    });
    expect(validation.ok).toBe(false);
    if (validation.ok) return;
    expect(validation.errors).toContain("servers[1].namespace is duplicated");
  });

  it("reserves Open Connector and RAG ids and namespaces for system-managed services", () => {
    const validation = validateGatewayMcpServersInput({
      servers: [
        mcpDraft({ id: "mcp-open-connector", namespace: "open-connector" }),
        mcpDraft({ id: "mcp-rag", namespace: "rag" }),
      ],
    });
    expect(validation.ok).toBe(false);
    if (validation.ok) return;
    expect(validation.errors).toContain("servers[0].id is reserved for a system-managed MCP service");
    expect(validation.errors).toContain("servers[0].namespace is reserved for a system-managed MCP service");
    expect(validation.errors).toContain("servers[1].id is reserved for a system-managed MCP service");
    expect(validation.errors).toContain("servers[1].namespace is reserved for a system-managed MCP service");
  });

  it("reserves public MCP proxy namespaces", () => {
    const validation = validateGatewayMcpServersInput({
      servers: [
        mcpDraft({ id: "mcp-kb-custom", namespace: "kb" }),
        mcpDraft({ id: "mcp-connector-custom", namespace: "connector" }),
        mcpDraft({ id: "mcp-prefixed-custom", namespace: "mcp-custom" }),
      ],
    });
    expect(validation.ok).toBe(false);
    if (validation.ok) return;
    expect(validation.errors).toContain("servers[0].namespace is reserved for the public MCP tool proxy");
    expect(validation.errors).toContain("servers[1].namespace is reserved for the public MCP tool proxy");
    expect(validation.errors).toContain("servers[2].namespace is reserved for the public MCP tool proxy");
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

  it("keeps all system-managed MCP routes when all channels are removed", async () => {
    await useTemporaryDataDirectory();
    process.env.OPEN_CONNECTOR_RUNTIME_TOKEN = "connector-runtime-token";
    process.env.LIGHTRAG_API_KEY = "lightrag-api-key";
    await saveGatewayChannels([draft()]);
    const paths = getGatewayConfigPaths();
    await saveGatewayChannels([]);
    const config = await readFile(paths.config, "utf8");
    expect(config).toContain("# ai-base-gateway-config-version: 2");
    expect(config).not.toContain("kind: AIGatewayRoute");
    expect(config).toContain("kind: MCPRoute");
    expect(config).toContain("mcp-open-connector");
    expect(config).toContain("mcp-rag");
    expect(await readFile(path.join(paths.mcpSecrets, "mcp-open-connector.key"), "utf8")).toBe("connector-runtime-token");
    expect(await readFile(path.join(paths.mcpSecrets, "mcp-rag.key"), "utf8")).toBe("lightrag-api-key");
    await expect(access(path.join(paths.secrets, "channel-openai.key"))).rejects.toThrow();
  });
});

describe("gateway MCP storage", () => {
  it("bootstraps system-managed MCP routes when the snapshot is first read", async () => {
    await useTemporaryDataDirectory();
    process.env.OPEN_CONNECTOR_RUNTIME_TOKEN = "connector-runtime-token";
    process.env.LIGHTRAG_API_KEY = "lightrag-api-key";

    const snapshot = await readGatewayMcpServers();
    expect(snapshot.servers.map((server) => server.id)).toEqual([
      "mcp-open-connector",
      "mcp-rag",
    ]);

    const paths = getGatewayConfigPaths();
    const config = await readFile(paths.config, "utf8");
    expect(config).toContain("mcp-open-connector");
    expect(config).toContain("mcp-rag");
    expect(await readFile(path.join(paths.mcpSecrets, "mcp-rag.key"), "utf8")).toBe("lightrag-api-key");
  });

  it("regenerates an older gateway config through the custom MCP adapter", async () => {
    await useTemporaryDataDirectory();
    await saveGatewayMcpServers([mcpDraft()]);
    const paths = getGatewayConfigPaths();
    await writeFile(paths.config, "# Generated by an older AI Console\nkind: MCPRoute\n", "utf8");

    await readGatewayMcpServers();

    const config = await readFile(paths.config, "utf8");
    expect(config).toContain("# ai-base-gateway-config-version: 2");
    expect(config).toContain('hostname: "mcp-backend-adapter"');
    expect(config).toContain('path: "/internal/v1/mcp-backends/github"');
  });

  it("persists MCP secrets separately and preserves model routes", async () => {
    await useTemporaryDataDirectory();
    process.env.LIGHTRAG_API_KEY = "lightrag-api-key";
    await saveGatewayChannels([draft()]);
    const saved = await saveGatewayMcpServers([mcpDraft()], new Date("2026-07-20T08:00:00.000Z"));
    const savedCustomServer = saved.servers.find((server) => server.id === "mcp-github");
    expect(saved.servers[0]).toMatchObject({ id: "mcp-open-connector", managed: true, enabled: true });
    expect(saved.servers[1]).toMatchObject({ id: "mcp-rag", managed: true, enabled: true });
    expect(savedCustomServer?.keyConfigured).toBe(true);
    expect(savedCustomServer).not.toHaveProperty("apiKey");

    const paths = getGatewayConfigPaths();
    expect(await readFile(path.join(paths.mcpSecrets, "mcp-github.key"), "utf8")).toBe("super-private-token");
    const config = await readFile(paths.config, "utf8");
    expect(config).toContain("kind: AIGatewayRoute");
    expect(config).toContain("kind: MCPRoute");
    expect(config).toContain("mcp-rag");
    expect(config).not.toContain("super-private-token");
    expect((await readGatewayMcpServers()).servers.find((server) => server.id === "mcp-github")?.keyConfigured).toBe(true);
    expect(JSON.parse(await readFile(paths.mcpServers, "utf8")).servers).toHaveLength(1);
  });

  it("removes MCP resources without removing model resources", async () => {
    await useTemporaryDataDirectory();
    await saveGatewayChannels([draft()]);
    await saveGatewayMcpServers([mcpDraft()]);
    await saveGatewayMcpServers([]);
    const paths = getGatewayConfigPaths();
    const config = await readFile(paths.config, "utf8");
    expect(config).toContain("kind: AIGatewayRoute");
    expect(config).toContain("kind: MCPRoute");
    expect(config).toContain("mcp-open-connector");
    expect(config).toContain("mcp-rag");
    expect(config).not.toContain("mcp-github");
    await expect(access(path.join(paths.mcpSecrets, "mcp-github.key"))).rejects.toThrow();
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

describe("gateway MCP connectivity test", () => {
  it("initializes an MCP session and reads the real tool list", async () => {
    const methods: string[] = [];
    let authorization = "";
    let toolsSession = "";
    let trafficOrigin = "";
    const server = createServer(async (request, response) => {
      let raw = "";
      for await (const chunk of request) raw += chunk.toString();
      const payload = JSON.parse(raw) as { id?: number; method: string; params?: { cursor?: string } };
      methods.push(payload.method);
      authorization = request.headers.authorization || authorization;
      trafficOrigin = String(request.headers["x-ai-base-traffic-origin"] || trafficOrigin);
      if (payload.method === "initialize") {
        response.setHeader("content-type", "application/json");
        response.setHeader("mcp-session-id", "session-1");
        response.end(JSON.stringify({ jsonrpc: "2.0", id: payload.id, result: { protocolVersion: "2025-06-18", capabilities: {}, serverInfo: { name: "test", version: "1" } } }));
      } else if (payload.method === "notifications/initialized") {
        response.statusCode = 202;
        response.end();
      } else {
        toolsSession = String(request.headers["mcp-session-id"] || "");
        response.setHeader("content-type", "application/json");
        response.end(JSON.stringify(payload.params?.cursor === "page-2"
          ? { jsonrpc: "2.0", id: payload.id, result: { tools: [{ name: "read", description: "Read a document" }] } }
          : { jsonrpc: "2.0", id: payload.id, result: { tools: [{ name: "search", description: "Search documents" }], nextCursor: "page-2" } }));
      }
    });
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    const address = server.address();
    if (!address || typeof address === "string") throw new Error("missing test server address");
    try {
      const result = await testGatewayMcpServer(mcpDraft({ url: `http://127.0.0.1:${address.port}/mcp` }));
      expect(result).toMatchObject({
        ok: true,
        discoveredTools: ["search", "read"],
        tools: [
          { name: "search", description: "Search documents" },
          { name: "read", description: "Read a document" },
        ],
      });
      expect(methods).toEqual(["initialize", "notifications/initialized", "tools/list", "tools/list"]);
      expect(authorization).toBe("Bearer super-private-token");
      expect(toolsSession).toBe("session-1");
      expect(trafficOrigin).toBe("management_probe");
    } finally {
      await new Promise<void>((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
    }
  });
});
