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

const CHANNELS_FILE_NAME = "llm-gateway-channels.json";
const GATEWAY_CONFIG_FILE_NAME = "llm-gateway-config.yaml";
const GATEWAY_REVISION_FILE_NAME = "llm-gateway-revision";
const SECRET_DIRECTORY_NAME = "llm-gateway-secrets";
const MAX_CHANNELS = 20;
const MAX_MODELS = 100;
const TEST_TIMEOUT_MS = 8_000;
const CHANNEL_ID_PATTERN = /^[a-z0-9][a-z0-9-]{0,47}$/;
const PROVIDERS = new Set<GatewayProvider>(["openai", "anthropic", "openai-compatible"]);

type StoredGatewayChannel = Omit<GatewayChannel, "keyConfigured">;
type StoredGatewayChannels = Omit<GatewayChannelsSnapshot, "channels"> & {
  channels: StoredGatewayChannel[];
};

type JsonObject = Record<string, unknown>;

export type GatewayChannelsValidation =
  | { ok: true; value: GatewayChannelDraft[] }
  | { ok: false; errors: string[] };

function isObject(value: unknown): value is JsonObject {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function dataDirectory() {
  return process.env.AI_CONSOLE_DATA_DIR || path.join(process.cwd(), ".data");
}

export function getGatewayConfigPaths() {
  const directory = dataDirectory();
  return {
    channels: path.join(directory, CHANNELS_FILE_NAME),
    config: path.join(directory, GATEWAY_CONFIG_FILE_NAME),
    revision: path.join(directory, GATEWAY_REVISION_FILE_NAME),
    secrets: path.join(directory, SECRET_DIRECTORY_NAME),
  };
}

function secretPath(id: string) {
  return path.join(getGatewayConfigPaths().secrets, `${id}.key`);
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
    keyConfigured: await fileExists(secretPath(channel.id)),
  })));
  return { ...stored, channels };
}

function yamlString(value: string) {
  return JSON.stringify(value);
}

function backendName(id: string) {
  return `llm-${id}`;
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

export function generateGatewayConfig(channels: GatewayChannel[]) {
  const enabled = channels.filter((channel) => channel.enabled && channel.keyConfigured);
  if (enabled.length === 0) return "";

  const rules = enabled.flatMap((channel) => channel.models.map((model) => {
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

  const route = `apiVersion: aigateway.envoyproxy.io/v1beta1
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
`;

  const backends = enabled.map((channel) => {
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

  return `${BASE_GATEWAY_CONFIG}${route}${backends}${trafficPolicy}`;
}

export async function saveGatewayChannels(
  drafts: GatewayChannelDraft[],
  now = new Date(),
): Promise<GatewayChannelsSnapshot> {
  const previous = await readGatewayChannels();
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
    if (draft.removeApiKey) await unlink(secretPath(draft.id)).catch(() => undefined);
    else if (draft.apiKey) await atomicWrite(secretPath(draft.id), draft.apiKey);
  }
  const retainedIds = new Set(drafts.map((draft) => draft.id));
  for (const previousChannel of previous.channels) {
    if (!retainedIds.has(previousChannel.id)) {
      await unlink(secretPath(previousChannel.id)).catch(() => undefined);
    }
  }

  const generated = generateGatewayConfig(channels);
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

async function resolveTestKey(draft: GatewayChannelDraft) {
  if (draft.apiKey) return draft.apiKey;
  if (draft.removeApiKey) return undefined;
  try {
    return (await readFile(secretPath(draft.id), "utf8")).trim();
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
