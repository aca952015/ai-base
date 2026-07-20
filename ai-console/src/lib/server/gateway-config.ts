import { randomUUID } from "node:crypto";
import { access, mkdir, readFile, rename, unlink, writeFile } from "node:fs/promises";
import { isIP } from "node:net";
import path from "node:path";

import type {
  GatewayChannel,
  GatewayChannelDraft,
  GatewayChannelsSnapshot,
  GatewayChannelTestResult,
  GatewayModelRoute,
  GatewayProvider,
} from "../control-plane/gateway";
import type {
  GatewayMcpServer,
  GatewayMcpServerDraft,
  GatewayMcpServersSnapshot,
  GatewayMcpServerTestResult,
  GatewayMcpTool,
} from "../control-plane/mcp";

const CHANNELS_FILE_NAME = "llm-gateway-channels.json";
const MCP_SERVERS_FILE_NAME = "llm-gateway-mcp-servers.json";
const GATEWAY_CONFIG_FILE_NAME = "llm-gateway-config.yaml";
const GATEWAY_REVISION_FILE_NAME = "llm-gateway-revision";
const SECRET_DIRECTORY_NAME = "llm-gateway-secrets";
const MCP_SECRET_DIRECTORY_NAME = "llm-gateway-mcp-secrets";
const OPEN_CONNECTOR_MCP_ID = "mcp-open-connector";
const OPEN_CONNECTOR_MCP_NAMESPACE = "open-connector";
const SYSTEM_MANAGED_TIMESTAMP = new Date(0).toISOString();
const MAX_CHANNELS = 20;
const MAX_MODELS = 100;
const MAX_MCP_SERVERS = 40;
const MAX_MCP_TOOL_FILTERS = 32;
const MAX_MCP_TOOL_PAGES = 100;
const TEST_TIMEOUT_MS = 8_000;
const CHANNEL_ID_PATTERN = /^[a-z0-9][a-z0-9-]{0,47}$/;
const MCP_NAMESPACE_PATTERN = /^[a-z0-9][a-z0-9-]{0,47}$/;
const HTTP_HEADER_PATTERN = /^[!#$%&'*+.^_`|~0-9A-Za-z-]+$/;
const PROVIDERS = new Set<GatewayProvider>(["openai", "anthropic", "openai-compatible"]);

type StoredGatewayChannel = Omit<GatewayChannel, "keyConfigured">;
type StoredGatewayChannels = Omit<GatewayChannelsSnapshot, "channels"> & {
  channels: StoredGatewayChannel[];
};
type StoredGatewayMcpServer = Omit<GatewayMcpServer, "keyConfigured" | "managed">;
type StoredGatewayMcpServers = Omit<GatewayMcpServersSnapshot, "servers"> & {
  servers: StoredGatewayMcpServer[];
};

type JsonObject = Record<string, unknown>;

export type GatewayChannelsValidation =
  | { ok: true; value: GatewayChannelDraft[] }
  | { ok: false; errors: string[] };
export type GatewayMcpServersValidation =
  | { ok: true; value: GatewayMcpServerDraft[] }
  | { ok: false; errors: string[] };

function isObject(value: unknown): value is JsonObject {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function dataDirectory() {
  return process.env.AI_CONSOLE_DATA_DIR || path.join(process.cwd(), ".data");
}

function openConnectorMcpUrl() {
  try {
    return new URL("mcp", `${(process.env.OPEN_CONNECTOR_URL || "http://localhost:8080/connector").replace(/\/$/, "")}/`).toString();
  } catch {
    return "http://localhost:8080/connector/mcp";
  }
}

function openConnectorRuntimeToken() {
  return process.env.OPEN_CONNECTOR_RUNTIME_TOKEN?.trim() || undefined;
}

export function isSystemManagedMcpServerId(id: unknown) {
  return id === OPEN_CONNECTOR_MCP_ID;
}

export function getSystemManagedMcpServer(): GatewayMcpServer {
  return {
    id: OPEN_CONNECTOR_MCP_ID,
    name: "Open Connector",
    namespace: OPEN_CONNECTOR_MCP_NAMESPACE,
    url: openConnectorMcpUrl(),
    enabled: true,
    managed: true,
    authHeader: "Authorization",
    toolIncludes: [],
    toolExcludes: [],
    keyConfigured: Boolean(openConnectorRuntimeToken()),
    createdAt: SYSTEM_MANAGED_TIMESTAMP,
    updatedAt: SYSTEM_MANAGED_TIMESTAMP,
  };
}

export function getGatewayConfigPaths() {
  const directory = dataDirectory();
  return {
    channels: path.join(directory, CHANNELS_FILE_NAME),
    mcpServers: path.join(directory, MCP_SERVERS_FILE_NAME),
    config: path.join(directory, GATEWAY_CONFIG_FILE_NAME),
    revision: path.join(directory, GATEWAY_REVISION_FILE_NAME),
    secrets: path.join(directory, SECRET_DIRECTORY_NAME),
    mcpSecrets: path.join(directory, MCP_SECRET_DIRECTORY_NAME),
  };
}

function channelSecretPath(id: string) {
  return path.join(getGatewayConfigPaths().secrets, `${id}.key`);
}

function mcpSecretPath(id: string) {
  return path.join(getGatewayConfigPaths().mcpSecrets, `${id}.key`);
}

async function fileExists(filePath: string) {
  try {
    await access(/* turbopackIgnore: true */ filePath);
    return true;
  } catch {
    return false;
  }
}

async function atomicWrite(filePath: string, value: string, mode = 0o600) {
  await mkdir(path.dirname(filePath), { recursive: true });
  const temporaryPath = `${filePath}.${process.pid}.${randomUUID()}.tmp`;
  try {
    await writeFile(temporaryPath, value, { encoding: "utf8", mode });
    await rename(temporaryPath, filePath);
  } finally {
    await unlink(temporaryPath).catch(() => undefined);
  }
}

function readModelRoute(value: unknown, field: string, errors: string[]): GatewayModelRoute | undefined {
  if (!isObject(value)) {
    errors.push(`${field} must be an object`);
    return undefined;
  }
  const publicName = typeof value.publicName === "string" ? value.publicName.trim() : "";
  const upstreamName = typeof value.upstreamName === "string" ? value.upstreamName.trim() : "";
  if (!publicName || publicName.length > 200 || /\s/.test(publicName)) {
    errors.push(`${field}.publicName must be a non-empty model name without spaces`);
  }
  if (!upstreamName || upstreamName.length > 200 || /\s/.test(upstreamName)) {
    errors.push(`${field}.upstreamName must be a non-empty model name without spaces`);
  }
  return publicName && upstreamName ? { publicName, upstreamName } : undefined;
}

function readChannelDraft(value: unknown, index: number, errors: string[]): GatewayChannelDraft | undefined {
  const field = `channels[${index}]`;
  if (!isObject(value)) {
    errors.push(`${field} must be an object`);
    return undefined;
  }

  const id = typeof value.id === "string" ? value.id.trim() : "";
  const name = typeof value.name === "string" ? value.name.trim() : "";
  const provider = value.provider as GatewayProvider;
  const baseUrlValue = typeof value.baseUrl === "string" ? value.baseUrl.trim() : "";
  const enabled = value.enabled;
  const apiKey = typeof value.apiKey === "string" ? value.apiKey.trim() : undefined;
  const removeApiKey = value.removeApiKey === true;

  if (!CHANNEL_ID_PATTERN.test(id)) errors.push(`${field}.id is invalid`);
  if (!name || name.length > 100) errors.push(`${field}.name must be between 1 and 100 characters`);
  if (!PROVIDERS.has(provider)) errors.push(`${field}.provider is unsupported`);
  if (typeof enabled !== "boolean") errors.push(`${field}.enabled must be a boolean`);
  if (apiKey !== undefined && apiKey.length > 10_000) errors.push(`${field}.apiKey is too long`);

  let baseUrl = baseUrlValue;
  try {
    const parsed = new URL(baseUrlValue);
    if (!["http:", "https:"].includes(parsed.protocol)) throw new Error("unsupported scheme");
    if (parsed.username || parsed.password || parsed.search || parsed.hash) throw new Error("unsupported URL parts");
    parsed.pathname = parsed.pathname.replace(/\/+$/, "") || "/";
    baseUrl = parsed.toString().replace(/\/$/, "");
  } catch {
    errors.push(`${field}.baseUrl must be an HTTP(S) URL without credentials, query, or fragment`);
  }

  const models: GatewayModelRoute[] = [];
  if (!Array.isArray(value.models) || value.models.length > MAX_MODELS) {
    errors.push(`${field}.models must be an array with at most ${MAX_MODELS} entries`);
  } else {
    value.models.forEach((model, modelIndex) => {
      const parsed = readModelRoute(model, `${field}.models[${modelIndex}]`, errors);
      if (parsed) models.push(parsed);
    });
  }
  if (enabled === true && models.length === 0) errors.push(`${field}.models needs at least one model when enabled`);

  if (!id || !name || !PROVIDERS.has(provider) || typeof enabled !== "boolean" || !baseUrl) {
    return undefined;
  }
  return { id, name, provider, baseUrl, enabled, models, apiKey, removeApiKey };
}

export function validateGatewayChannelsInput(input: unknown): GatewayChannelsValidation {
  if (!isObject(input) || !Array.isArray(input.channels)) {
    return { ok: false, errors: ["request body must contain a channels array"] };
  }
  if (input.channels.length > MAX_CHANNELS) {
    return { ok: false, errors: [`channels must contain at most ${MAX_CHANNELS} entries`] };
  }

  const errors: string[] = [];
  const channels = input.channels
    .map((channel, index) => readChannelDraft(channel, index, errors))
    .filter((channel): channel is GatewayChannelDraft => Boolean(channel));
  const ids = new Set<string>();
  const publishedModels = new Set<string>();
  for (const [index, channel] of channels.entries()) {
    if (ids.has(channel.id)) errors.push(`channels[${index}].id is duplicated`);
    ids.add(channel.id);
    if (!channel.enabled) continue;
    for (const model of channel.models) {
      if (publishedModels.has(model.publicName)) {
        errors.push(`published model ${model.publicName} is configured by more than one enabled channel`);
      }
      publishedModels.add(model.publicName);
    }
  }
  return errors.length > 0 ? { ok: false, errors } : { ok: true, value: channels };
}

function readStringList(value: unknown, field: string, errors: string[]) {
  if (!Array.isArray(value) || value.length > MAX_MCP_TOOL_FILTERS) {
    errors.push(`${field} must be an array with at most ${MAX_MCP_TOOL_FILTERS} entries`);
    return [];
  }
  const values: string[] = [];
  value.forEach((entry, index) => {
    const normalized = typeof entry === "string" ? entry.trim() : "";
    if (!normalized || normalized.length > 200) {
      errors.push(`${field}[${index}] must be between 1 and 200 characters`);
      return;
    }
    if (!values.includes(normalized)) values.push(normalized);
  });
  return values;
}

function readMcpServerDraft(value: unknown, index: number, errors: string[]): GatewayMcpServerDraft | undefined {
  const field = `servers[${index}]`;
  if (!isObject(value)) {
    errors.push(`${field} must be an object`);
    return undefined;
  }

  const id = typeof value.id === "string" ? value.id.trim() : "";
  const name = typeof value.name === "string" ? value.name.trim() : "";
  const namespace = typeof value.namespace === "string" ? value.namespace.trim() : "";
  const urlValue = typeof value.url === "string" ? value.url.trim() : "";
  const enabled = value.enabled;
  const authHeader = typeof value.authHeader === "string" ? value.authHeader.trim() : "Authorization";
  const apiKey = typeof value.apiKey === "string" ? value.apiKey.trim() : undefined;
  const removeApiKey = value.removeApiKey === true;

  if (!CHANNEL_ID_PATTERN.test(id)) errors.push(`${field}.id is invalid`);
  if (!name || name.length > 100) errors.push(`${field}.name must be between 1 and 100 characters`);
  if (!MCP_NAMESPACE_PATTERN.test(namespace)) errors.push(`${field}.namespace is invalid`);
  if (typeof enabled !== "boolean") errors.push(`${field}.enabled must be a boolean`);
  if (!authHeader || authHeader.length > 100 || !HTTP_HEADER_PATTERN.test(authHeader)) {
    errors.push(`${field}.authHeader must be a valid HTTP header name`);
  }
  if (apiKey !== undefined && apiKey.length > 10_000) errors.push(`${field}.apiKey is too long`);

  let url = urlValue;
  try {
    const parsed = new URL(urlValue);
    if (!["http:", "https:"].includes(parsed.protocol)) throw new Error("unsupported scheme");
    if (parsed.username || parsed.password || parsed.search || parsed.hash) throw new Error("unsupported URL parts");
    parsed.pathname = parsed.pathname.replace(/\/+$/, "") || "/mcp";
    url = parsed.toString().replace(/\/$/, "");
  } catch {
    errors.push(`${field}.url must be an HTTP(S) URL without credentials, query, or fragment`);
  }

  const toolIncludes = readStringList(value.toolIncludes, `${field}.toolIncludes`, errors);
  const toolExcludes = readStringList(value.toolExcludes, `${field}.toolExcludes`, errors);

  if (!id || !name || !namespace || !url || typeof enabled !== "boolean" || !authHeader) return undefined;
  return {
    id,
    name,
    namespace,
    url,
    enabled,
    authHeader,
    toolIncludes,
    toolExcludes,
    apiKey,
    removeApiKey,
  };
}

export function validateGatewayMcpServersInput(input: unknown): GatewayMcpServersValidation {
  if (!isObject(input) || !Array.isArray(input.servers)) {
    return { ok: false, errors: ["request body must contain a servers array"] };
  }
  if (input.servers.length > MAX_MCP_SERVERS) {
    return { ok: false, errors: [`servers must contain at most ${MAX_MCP_SERVERS} entries`] };
  }

  const errors: string[] = [];
  const servers = input.servers
    .map((server, index) => readMcpServerDraft(server, index, errors))
    .filter((server): server is GatewayMcpServerDraft => Boolean(server));
  const ids = new Set<string>();
  const namespaces = new Set<string>();
  for (const [index, server] of servers.entries()) {
    if (server.id === OPEN_CONNECTOR_MCP_ID) {
      errors.push(`servers[${index}].id is reserved for the system-managed Open Connector service`);
    }
    if (server.namespace === OPEN_CONNECTOR_MCP_NAMESPACE) {
      errors.push(`servers[${index}].namespace is reserved for the system-managed Open Connector service`);
    }
    if (ids.has(server.id)) errors.push(`servers[${index}].id is duplicated`);
    if (namespaces.has(server.namespace)) errors.push(`servers[${index}].namespace is duplicated`);
    ids.add(server.id);
    namespaces.add(server.namespace);
  }
  return errors.length > 0 ? { ok: false, errors } : { ok: true, value: servers };
}

async function readStoredChannels(): Promise<StoredGatewayChannels> {
  try {
    return JSON.parse(await readFile(
      /* turbopackIgnore: true */ getGatewayConfigPaths().channels,
      "utf8",
    )) as StoredGatewayChannels;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
    return { channels: [], updatedAt: new Date(0).toISOString(), revision: "bootstrap" };
  }
}

export async function readGatewayChannels(): Promise<GatewayChannelsSnapshot> {
  const stored = await readStoredChannels();
  const channels = await Promise.all(stored.channels.map(async (channel) => ({
    ...channel,
    keyConfigured: await fileExists(channelSecretPath(channel.id)),
  })));
  return { ...stored, channels };
}

async function readStoredMcpServers(): Promise<StoredGatewayMcpServers> {
  try {
    const stored = JSON.parse(await readFile(
      /* turbopackIgnore: true */ getGatewayConfigPaths().mcpServers,
      "utf8",
    )) as StoredGatewayMcpServers;
    return {
      ...stored,
      servers: stored.servers.filter((server) => server.id !== OPEN_CONNECTOR_MCP_ID),
    };
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
    return { servers: [], updatedAt: new Date(0).toISOString(), revision: "bootstrap" };
  }
}

export async function readGatewayMcpServers(): Promise<GatewayMcpServersSnapshot> {
  const stored = await readStoredMcpServers();
  const servers = await Promise.all(stored.servers.map(async (server) => ({
    ...server,
    managed: false,
    keyConfigured: await fileExists(mcpSecretPath(server.id)),
  })));
  return { ...stored, servers: [getSystemManagedMcpServer(), ...servers] };
}

async function syncSystemManagedMcpSecret() {
  const token = openConnectorRuntimeToken();
  if (token) await atomicWrite(mcpSecretPath(OPEN_CONNECTOR_MCP_ID), token);
  else await unlink(mcpSecretPath(OPEN_CONNECTOR_MCP_ID)).catch(() => undefined);
}

function yamlString(value: string) {
  return JSON.stringify(value);
}

function backendName(id: string) {
  return `llm-${id}`;
}

function mcpBackendName(namespace: string) {
  return `mcp-${namespace}`;
}

function endpointParts(baseUrl: string) {
  const value = new URL(baseUrl);
  const hostname = value.hostname;
  const port = Number(value.port || (value.protocol === "https:" ? 443 : 80));
  const pathPrefix = value.pathname === "/" || value.pathname === "/v1"
    ? undefined
    : value.pathname.replace(/\/$/, "");
  return { hostname, port, tls: value.protocol === "https:", pathPrefix };
}

const BASE_GATEWAY_CONFIG = `# Generated by AI Console. Do not edit by hand.
apiVersion: gateway.networking.k8s.io/v1
kind: GatewayClass
metadata:
  name: ai-base-llm
spec:
  controllerName: gateway.envoyproxy.io/gatewayclass-controller
---
apiVersion: gateway.networking.k8s.io/v1
kind: Gateway
metadata:
  name: ai-base-llm
  namespace: default
spec:
  gatewayClassName: ai-base-llm
  listeners:
    - name: http
      protocol: HTTP
      port: 1975
  infrastructure:
    parametersRef:
      group: gateway.envoyproxy.io
      kind: EnvoyProxy
      name: ai-base-llm
---
apiVersion: gateway.envoyproxy.io/v1alpha1
kind: EnvoyProxy
metadata:
  name: ai-base-llm
  namespace: default
spec:
  logging:
    level:
      default: error
---
`;

export function generateGatewayConfig(channels: GatewayChannel[], mcpServers: GatewayMcpServer[] = []) {
  const enabledChannels = channels.filter((channel) => channel.enabled && channel.keyConfigured);
  const enabledMcpServers = mcpServers.filter((server) => server.enabled);
  if (enabledChannels.length === 0 && enabledMcpServers.length === 0) return "";

  const rules = enabledChannels.flatMap((channel) => channel.models.map((model) => {
    const override = model.upstreamName === model.publicName
      ? ""
      : `\n          modelNameOverride: ${yamlString(model.upstreamName)}`;
    return `    - matches:
        - headers:
            - type: Exact
              name: x-ai-eg-model
              value: ${yamlString(model.publicName)}
      backendRefs:
        - name: ${backendName(channel.id)}
          namespace: default${override}
      timeouts:
        request: 120s`;
  })).join("\n");

  const route = enabledChannels.length > 0 ? `apiVersion: aigateway.envoyproxy.io/v1beta1
kind: AIGatewayRoute
metadata:
  name: ai-base-llm
  namespace: default
spec:
  parentRefs:
    - name: ai-base-llm
      kind: Gateway
      group: gateway.networking.k8s.io
  rules:
${rules}
  llmRequestCosts:
    - metadataKey: llm_input_token
      type: InputToken
    - metadataKey: llm_output_token
      type: OutputToken
---
` : "";

  const backends = enabledChannels.map((channel) => {
    const name = backendName(channel.id);
    const endpoint = endpointParts(channel.baseUrl);
    const endpointBlock = isIP(endpoint.hostname)
      ? `ip:\n        address: ${yamlString(endpoint.hostname)}`
      : `fqdn:\n        hostname: ${yamlString(endpoint.hostname)}`;
    const prefix = endpoint.pathPrefix ? `\n    prefix: ${yamlString(endpoint.pathPrefix)}` : "";
    const schemaName = channel.provider === "anthropic" ? "Anthropic" : "OpenAI";
    const secretPolicy = channel.provider === "anthropic"
      ? `  type: AnthropicAPIKey\n  anthropicAPIKey:\n    secretRef:\n      name: ${name}-key`
      : `  type: APIKey\n  apiKey:\n    secretRef:\n      name: ${name}-key`;
    const tlsPolicy = endpoint.tls ? `apiVersion: gateway.networking.k8s.io/v1alpha3
kind: BackendTLSPolicy
metadata:
  name: ${name}-tls
  namespace: default
spec:
  targetRefs:
    - group: gateway.envoyproxy.io
      kind: Backend
      name: ${name}
  validation:
    wellKnownCACertificates: System
    hostname: ${yamlString(endpoint.hostname)}
---
` : "";
    return `apiVersion: gateway.envoyproxy.io/v1alpha1
kind: Backend
metadata:
  name: ${name}
  namespace: default
spec:
  endpoints:
    - ${endpointBlock}
        port: ${endpoint.port}
---
${tlsPolicy}apiVersion: aigateway.envoyproxy.io/v1beta1
kind: AIServiceBackend
metadata:
  name: ${name}
  namespace: default
spec:
  timeouts:
    request: 3m
  schema:
    name: ${schemaName}${prefix}
  backendRef:
    name: ${name}
    kind: Backend
    group: gateway.envoyproxy.io
    namespace: default
---
apiVersion: v1
kind: Secret
metadata:
  name: ${name}-key
  namespace: default
  annotations:
    substitution.aigw.run/file/apiKey: ${yamlString(`/control/${SECRET_DIRECTORY_NAME}/${channel.id}.key`)}
type: Opaque
stringData:
  apiKey: replaced-at-runtime
---
apiVersion: aigateway.envoyproxy.io/v1beta1
kind: BackendSecurityPolicy
metadata:
  name: ${name}-key
  namespace: default
spec:
  targetRefs:
    - group: aigateway.envoyproxy.io
      kind: AIServiceBackend
      name: ${name}
${secretPolicy}
---
`;
  }).join("");

  const mcpBackendRefs = enabledMcpServers.map((server) => {
    const name = mcpBackendName(server.namespace);
    const endpoint = new URL(server.url);
    const backendPath = endpoint.pathname || "/mcp";
    const toolIncludes = server.toolIncludes.length > 0
      ? `\n      toolSelector:\n        include:\n${server.toolIncludes.map((tool) => `          - ${yamlString(tool)}`).join("\n")}`
      : "";
    const toolExcludes = server.toolExcludes.length > 0
      ? `${server.toolIncludes.length > 0 ? "" : "\n      toolSelector:"}\n        exclude:\n${server.toolExcludes.map((tool) => `          - ${yamlString(tool)}`).join("\n")}`
      : "";
    const securityPolicy = server.keyConfigured
      ? `\n      securityPolicy:\n        apiKey:\n          secretRef:\n            name: ${name}-key\n          header: ${yamlString(server.authHeader)}`
      : "";
    return `    - name: ${name}
      kind: Backend
      group: gateway.envoyproxy.io
      path: ${yamlString(backendPath)}${toolIncludes}${toolExcludes}${securityPolicy}`;
  }).join("\n");

  const mcpRoute = enabledMcpServers.length > 0 ? `apiVersion: aigateway.envoyproxy.io/v1beta1
kind: MCPRoute
metadata:
  name: ai-base-mcp
  namespace: default
spec:
  parentRefs:
    - name: ai-base-llm
      kind: Gateway
      group: gateway.networking.k8s.io
  path: "/mcp"
  backendRefs:
${mcpBackendRefs}
---
` : "";

  const mcpBackends = enabledMcpServers.map((server) => {
    const name = mcpBackendName(server.namespace);
    const endpoint = new URL(server.url);
    const hostname = endpoint.hostname;
    const port = Number(endpoint.port || (endpoint.protocol === "https:" ? 443 : 80));
    const endpointBlock = isIP(hostname)
      ? `ip:\n        address: ${yamlString(hostname)}`
      : `fqdn:\n        hostname: ${yamlString(hostname)}`;
    const tlsPolicy = endpoint.protocol === "https:" ? `apiVersion: gateway.networking.k8s.io/v1alpha3
kind: BackendTLSPolicy
metadata:
  name: ${name}-tls
  namespace: default
spec:
  targetRefs:
    - group: gateway.envoyproxy.io
      kind: Backend
      name: ${name}
  validation:
    wellKnownCACertificates: System
    hostname: ${yamlString(hostname)}
---
` : "";
    const secret = server.keyConfigured ? `apiVersion: v1
kind: Secret
metadata:
  name: ${name}-key
  namespace: default
  annotations:
    substitution.aigw.run/file/apiKey: ${yamlString(`/control/${MCP_SECRET_DIRECTORY_NAME}/${server.id}.key`)}
type: Opaque
stringData:
  apiKey: replaced-at-runtime
---
` : "";
    return `apiVersion: gateway.envoyproxy.io/v1alpha1
kind: Backend
metadata:
  name: ${name}
  namespace: default
spec:
  endpoints:
    - ${endpointBlock}
        port: ${port}
---
${tlsPolicy}${secret}`;
  }).join("");

  const trafficPolicy = `apiVersion: gateway.envoyproxy.io/v1alpha1
kind: ClientTrafficPolicy
metadata:
  name: ai-base-llm-buffer
  namespace: default
spec:
  targetRefs:
    - group: gateway.networking.k8s.io
      kind: Gateway
      name: ai-base-llm
  connection:
    bufferLimit: 50Mi
`;

  return `${BASE_GATEWAY_CONFIG}${route}${backends}${mcpRoute}${mcpBackends}${trafficPolicy}`;
}

export async function saveGatewayChannels(
  drafts: GatewayChannelDraft[],
  now = new Date(),
): Promise<GatewayChannelsSnapshot> {
  const [previous, mcpSnapshot] = await Promise.all([
    readGatewayChannels(),
    readGatewayMcpServers(),
  ]);
  const previousById = new Map(previous.channels.map((channel) => [channel.id, channel]));
  const errors: string[] = [];
  const keyConfigured = await Promise.all(drafts.map(async (draft) => {
    const hasExisting = previousById.get(draft.id)?.keyConfigured === true;
    const hasReplacement = Boolean(draft.apiKey);
    const configured = !draft.removeApiKey && (hasReplacement || hasExisting);
    if (draft.enabled && !configured) errors.push(`${draft.name} 启用前必须配置 API Key`);
    return configured;
  }));
  if (errors.length > 0) throw new Error(errors.join("；"));

  const timestamp = now.toISOString();
  const revision = randomUUID();
  const channels: GatewayChannel[] = drafts.map((draft, index) => ({
    id: draft.id,
    name: draft.name,
    provider: draft.provider,
    baseUrl: draft.baseUrl,
    enabled: draft.enabled,
    models: draft.models,
    keyConfigured: keyConfigured[index],
    createdAt: previousById.get(draft.id)?.createdAt || timestamp,
    updatedAt: timestamp,
  }));

  const paths = getGatewayConfigPaths();
  await mkdir(paths.secrets, { recursive: true });
  for (const draft of drafts) {
    if (draft.removeApiKey) await unlink(channelSecretPath(draft.id)).catch(() => undefined);
    else if (draft.apiKey) await atomicWrite(channelSecretPath(draft.id), draft.apiKey);
  }
  const retainedIds = new Set(drafts.map((draft) => draft.id));
  for (const previousChannel of previous.channels) {
    if (!retainedIds.has(previousChannel.id)) {
      await unlink(channelSecretPath(previousChannel.id)).catch(() => undefined);
    }
  }

  await syncSystemManagedMcpSecret();
  const generated = generateGatewayConfig(channels, mcpSnapshot.servers);
  if (generated) await atomicWrite(paths.config, generated);
  else await unlink(paths.config).catch(() => undefined);

  const stored: StoredGatewayChannels = {
    channels: channels.map((channel) => ({
      id: channel.id,
      name: channel.name,
      provider: channel.provider,
      baseUrl: channel.baseUrl,
      enabled: channel.enabled,
      models: channel.models,
      createdAt: channel.createdAt,
      updatedAt: channel.updatedAt,
    })),
    updatedAt: timestamp,
    revision,
  };
  await atomicWrite(paths.channels, `${JSON.stringify(stored, null, 2)}\n`);
  await atomicWrite(paths.revision, `${revision}\n`, 0o644);
  return { channels, updatedAt: timestamp, revision };
}

export async function saveGatewayMcpServers(
  drafts: GatewayMcpServerDraft[],
  now = new Date(),
): Promise<GatewayMcpServersSnapshot> {
  const [previous, channelSnapshot] = await Promise.all([
    readGatewayMcpServers(),
    readGatewayChannels(),
  ]);
  const previousUserServers = previous.servers.filter((server) => !server.managed);
  const previousById = new Map(previousUserServers.map((server) => [server.id, server]));
  const keyConfigured = drafts.map((draft) => {
    const hasExisting = previousById.get(draft.id)?.keyConfigured === true;
    return !draft.removeApiKey && (Boolean(draft.apiKey) || hasExisting);
  });

  const timestamp = now.toISOString();
  const revision = randomUUID();
  const servers: GatewayMcpServer[] = drafts.map((draft, index) => ({
    id: draft.id,
    name: draft.name,
    namespace: draft.namespace,
    url: draft.url,
    enabled: draft.enabled,
    managed: false,
    authHeader: draft.authHeader,
    toolIncludes: draft.toolIncludes,
    toolExcludes: draft.toolExcludes,
    keyConfigured: keyConfigured[index],
    createdAt: previousById.get(draft.id)?.createdAt || timestamp,
    updatedAt: timestamp,
  }));

  const paths = getGatewayConfigPaths();
  await mkdir(paths.mcpSecrets, { recursive: true });
  for (const draft of drafts) {
    if (draft.removeApiKey) await unlink(mcpSecretPath(draft.id)).catch(() => undefined);
    else if (draft.apiKey) await atomicWrite(mcpSecretPath(draft.id), draft.apiKey);
  }
  const retainedIds = new Set(drafts.map((draft) => draft.id));
  for (const previousServer of previousUserServers) {
    if (!retainedIds.has(previousServer.id)) {
      await unlink(mcpSecretPath(previousServer.id)).catch(() => undefined);
    }
  }

  await syncSystemManagedMcpSecret();
  const allServers = [getSystemManagedMcpServer(), ...servers];
  const generated = generateGatewayConfig(channelSnapshot.channels, allServers);
  if (generated) await atomicWrite(paths.config, generated);
  else await unlink(paths.config).catch(() => undefined);

  const stored: StoredGatewayMcpServers = {
    servers: servers.map((server) => ({
      id: server.id,
      name: server.name,
      namespace: server.namespace,
      url: server.url,
      enabled: server.enabled,
      authHeader: server.authHeader,
      toolIncludes: server.toolIncludes,
      toolExcludes: server.toolExcludes,
      createdAt: server.createdAt,
      updatedAt: server.updatedAt,
    })),
    updatedAt: timestamp,
    revision,
  };
  await atomicWrite(paths.mcpServers, `${JSON.stringify(stored, null, 2)}\n`);
  await atomicWrite(paths.revision, `${revision}\n`, 0o644);
  return { servers: allServers, updatedAt: timestamp, revision };
}

async function resolveTestKey(draft: GatewayChannelDraft) {
  if (draft.apiKey) return draft.apiKey;
  if (draft.removeApiKey) return undefined;
  try {
    return (await readFile(channelSecretPath(draft.id), "utf8")).trim();
  } catch {
    return undefined;
  }
}

export async function testGatewayChannel(draft: GatewayChannelDraft): Promise<GatewayChannelTestResult> {
  const apiKey = await resolveTestKey(draft);
  if (!apiKey) return { ok: false, latencyMs: 0, message: "请先输入 API Key", discoveredModels: [] };

  const url = new URL(draft.baseUrl);
  url.pathname = `${url.pathname.replace(/\/$/, "")}/models`;
  const headers: HeadersInit = draft.provider === "anthropic"
    ? { "x-api-key": apiKey, "anthropic-version": "2023-06-01" }
    : { Authorization: `Bearer ${apiKey}` };
  const startedAt = Date.now();
  try {
    const response = await fetch(url, {
      headers,
      cache: "no-store",
      signal: AbortSignal.timeout(TEST_TIMEOUT_MS),
    });
    let discoveredModels: string[] = [];
    try {
      const payload = await response.json() as { data?: Array<{ id?: string }>; models?: Array<{ name?: string }> };
      discoveredModels = (payload.data || []).map((item) => item.id).filter((id): id is string => Boolean(id));
      if (discoveredModels.length === 0) {
        discoveredModels = (payload.models || []).map((item) => item.name).filter((id): id is string => Boolean(id));
      }
    } catch {
      // Some compatible providers return an empty body for an auth or readiness probe.
    }
    return {
      ok: response.ok,
      status: response.status,
      latencyMs: Date.now() - startedAt,
      message: response.ok
        ? `连接成功，发现 ${discoveredModels.length} 个模型`
        : `渠道返回 HTTP ${response.status}`,
      discoveredModels: discoveredModels.slice(0, MAX_MODELS),
    };
  } catch (error) {
    const timedOut = error instanceof Error && error.name === "TimeoutError";
    return {
      ok: false,
      latencyMs: Date.now() - startedAt,
      message: timedOut ? "连接测试超时（8 秒）" : "无法连接渠道端点",
      discoveredModels: [],
    };
  }
}

async function resolveMcpTestKey(draft: GatewayMcpServerDraft) {
  if (draft.id === OPEN_CONNECTOR_MCP_ID) return openConnectorRuntimeToken();
  if (draft.apiKey) return draft.apiKey;
  if (draft.removeApiKey) return undefined;
  try {
    return (await readFile(mcpSecretPath(draft.id), "utf8")).trim();
  } catch {
    return undefined;
  }
}

function parseMcpPayload(value: string, contentType: string | null): JsonObject | undefined {
  if (!value.trim()) return undefined;
  const candidates = contentType?.includes("text/event-stream")
    ? value.split(/\r?\n/).filter((line) => line.startsWith("data:")).map((line) => line.slice(5).trim())
    : [value];
  for (const candidate of candidates) {
    try {
      const payload = JSON.parse(candidate) as unknown;
      if (isObject(payload)) return payload;
    } catch {
      // Ignore keepalive and non-JSON SSE events.
    }
  }
  return undefined;
}

async function postMcpRequest(url: string, headers: Headers, body: JsonObject, signal: AbortSignal) {
  const response = await fetch(url, {
    method: "POST",
    headers,
    body: JSON.stringify(body),
    cache: "no-store",
    redirect: "error",
    signal,
  });
  return {
    response,
    payload: parseMcpPayload(await response.text(), response.headers.get("content-type")),
  };
}

export async function testGatewayMcpServer(draft: GatewayMcpServerDraft): Promise<GatewayMcpServerTestResult> {
  const startedAt = Date.now();
  const headers = new Headers({
    Accept: "application/json, text/event-stream",
    "Content-Type": "application/json",
  });
  const apiKey = await resolveMcpTestKey(draft);
  if (apiKey) {
    headers.set(
      draft.authHeader,
      draft.authHeader.toLowerCase() === "authorization" ? `Bearer ${apiKey}` : apiKey,
    );
  }
  const signal = AbortSignal.timeout(TEST_TIMEOUT_MS);

  try {
    const initialize = await postMcpRequest(draft.url, headers, {
      jsonrpc: "2.0",
      id: 1,
      method: "initialize",
      params: {
        protocolVersion: "2025-06-18",
        capabilities: {},
        clientInfo: { name: "ai-base-console", version: "0.1.0" },
      },
    }, signal);
    if (!initialize.response.ok) {
      return {
        ok: false,
        status: initialize.response.status,
        latencyMs: Date.now() - startedAt,
        message: `MCP 服务返回 HTTP ${initialize.response.status}`,
        discoveredTools: [],
        tools: [],
      };
    }
    if (isObject(initialize.payload?.error)) {
      const message = typeof initialize.payload.error.message === "string"
        ? initialize.payload.error.message
        : "MCP initialize 失败";
      return { ok: false, latencyMs: Date.now() - startedAt, message, discoveredTools: [], tools: [] };
    }

    const sessionId = initialize.response.headers.get("mcp-session-id");
    if (sessionId) headers.set("MCP-Session-Id", sessionId);
    headers.set("MCP-Protocol-Version", "2025-06-18");

    const initialized = await postMcpRequest(draft.url, headers, {
      jsonrpc: "2.0",
      method: "notifications/initialized",
    }, signal);
    if (!initialized.response.ok) {
      return {
        ok: false,
        status: initialized.response.status,
        latencyMs: Date.now() - startedAt,
        message: `MCP 初始化确认返回 HTTP ${initialized.response.status}`,
        discoveredTools: [],
        tools: [],
      };
    }

    const discoveredToolMap = new Map<string, GatewayMcpTool>();
    const visitedCursors = new Set<string>();
    let cursor: string | undefined;
    let page = 0;
    let toolsStatus = 200;
    do {
      page += 1;
      const toolsResult = await postMcpRequest(draft.url, headers, {
        jsonrpc: "2.0",
        id: page + 1,
        method: "tools/list",
        params: cursor ? { cursor } : {},
      }, signal);
      toolsStatus = toolsResult.response.status;
      if (!toolsResult.response.ok) {
        return {
          ok: false,
          status: toolsResult.response.status,
          latencyMs: Date.now() - startedAt,
          message: `工具列表返回 HTTP ${toolsResult.response.status}`,
          discoveredTools: [],
          tools: [],
        };
      }
      const result = isObject(toolsResult.payload?.result) ? toolsResult.payload.result : undefined;
      if (Array.isArray(result?.tools)) {
        for (const tool of result.tools) {
          if (!isObject(tool) || typeof tool.name !== "string" || !tool.name.trim()) continue;
          const name = tool.name.trim();
          const description = typeof tool.description === "string" && tool.description.trim()
            ? tool.description.trim()
            : undefined;
          discoveredToolMap.set(name, { name, description });
        }
      }
      const nextCursor = typeof result?.nextCursor === "string" && result.nextCursor.trim()
        ? result.nextCursor.trim()
        : undefined;
      if (!nextCursor) {
        cursor = undefined;
      } else if (visitedCursors.has(nextCursor)) {
        return {
          ok: false,
          latencyMs: Date.now() - startedAt,
          message: "MCP 工具列表返回了重复的分页游标",
          discoveredTools: [],
          tools: [],
        };
      } else if (page >= MAX_MCP_TOOL_PAGES) {
        return {
          ok: false,
          latencyMs: Date.now() - startedAt,
          message: `MCP 工具列表超过 ${MAX_MCP_TOOL_PAGES} 页`,
          discoveredTools: [],
          tools: [],
        };
      } else {
        visitedCursors.add(nextCursor);
        cursor = nextCursor;
      }
    } while (cursor);

    const tools = Array.from(discoveredToolMap.values());
    const discoveredTools = tools.map((tool) => tool.name);
    return {
      ok: true,
      status: toolsStatus,
      latencyMs: Date.now() - startedAt,
      message: `连接成功，发现 ${discoveredTools.length} 个工具`,
      discoveredTools,
      tools,
    };
  } catch (error) {
    const timedOut = error instanceof Error && ["TimeoutError", "AbortError"].includes(error.name);
    return {
      ok: false,
      latencyMs: Date.now() - startedAt,
      message: timedOut ? "连接测试超时（8 秒）" : "无法连接 MCP 服务",
      discoveredTools: [],
      tools: [],
    };
  }
}
