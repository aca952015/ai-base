import type {
  ConnectorActionDefinition,
  ConnectorAuthDefinition,
  ConnectorAuthType,
  ConnectorConnection,
  ConnectorConnectionInput,
  ConnectorConnectionsSnapshot,
  ConnectorCredentialField,
  ConnectorOAuthAuthorization,
  ConnectorOAuthClientField,
  ConnectorOAuthConfig,
  ConnectorOAuthConfigInput,
  ConnectorProviderDetail,
  ConnectorProviderSummary,
  ConnectorProvidersPage,
} from "../control-plane/connectors";

const FETCH_TIMEOUT_MS = 5_000;
const PROVIDER_CACHE_TTL_MS = 5 * 60_000;
const AUTH_TYPES = new Set<ConnectorAuthType>(["no_auth", "api_key", "custom_credential", "oauth2"]);
const FIELD_INPUT_TYPES = new Set<ConnectorCredentialField["inputType"]>(["text", "password", "textarea", "json"]);

let providerCache: { expiresAt: number; providers: ConnectorProviderSummary[] } | undefined;

export class OpenConnectorError extends Error {
  readonly status: number;

  constructor(message: string, status = 502) {
    super(message);
    this.name = "OpenConnectorError";
    this.status = status;
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function optionalString(value: unknown) {
  return typeof value === "string" && value.trim() ? value.trim() : undefined;
}

function stringArray(value: unknown) {
  return Array.isArray(value)
    ? value.filter((item): item is string => typeof item === "string" && Boolean(item.trim())).map((item) => item.trim())
    : [];
}

function connectorBaseUrl() {
  return (process.env.OPEN_CONNECTOR_URL || "http://localhost:8080/connector").replace(/\/$/, "");
}

function connectorUrl(pathname: string) {
  return new URL(pathname.replace(/^\//, ""), `${connectorBaseUrl()}/`).toString();
}

function adminHeaders(body = false): HeadersInit {
  const token = process.env.OPEN_CONNECTOR_ADMIN_TOKEN?.trim();
  if (!token) throw new OpenConnectorError("OpenConnector Admin Token 未配置", 503);
  return {
    Authorization: `Bearer ${token}`,
    ...(body ? { "content-type": "application/json" } : {}),
  };
}

function upstreamErrorMessage(payload: unknown, fallback: string) {
  if (!isRecord(payload)) return fallback;
  if (typeof payload.error === "string") return payload.error;
  if (isRecord(payload.error) && typeof payload.error.message === "string") return payload.error.message;
  if (typeof payload.message === "string") return payload.message;
  return fallback;
}

async function requestOpenConnector<T>(pathname: string, init?: RequestInit): Promise<T> {
  const response = await fetch(connectorUrl(pathname), {
    ...init,
    cache: "no-store",
    headers: {
      ...adminHeaders(Boolean(init?.body)),
      ...init?.headers,
    },
    signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
  });
  const payload = await response.json().catch(() => undefined) as unknown;
  if (!response.ok) {
    throw new OpenConnectorError(
      upstreamErrorMessage(payload, `OpenConnector 请求失败（${response.status}）`),
      response.status >= 400 && response.status < 600 ? response.status : 502,
    );
  }
  return payload as T;
}

function normalizeAuthType(value: unknown): ConnectorAuthType | undefined {
  return typeof value === "string" && AUTH_TYPES.has(value as ConnectorAuthType)
    ? value as ConnectorAuthType
    : undefined;
}

function normalizeCredentialField(value: unknown): ConnectorCredentialField | undefined {
  if (!isRecord(value)) return undefined;
  const key = optionalString(value.key);
  const label = optionalString(value.label);
  const inputType = typeof value.inputType === "string" && FIELD_INPUT_TYPES.has(value.inputType as ConnectorCredentialField["inputType"])
    ? value.inputType as ConnectorCredentialField["inputType"]
    : undefined;
  if (!key || !label || !inputType) return undefined;
  return {
    key,
    label,
    inputType,
    required: value.required === true,
    secret: value.secret === true,
    placeholder: optionalString(value.placeholder),
    description: optionalString(value.description),
  };
}

function normalizeOAuthClientField(value: unknown): ConnectorOAuthClientField | undefined {
  const field = normalizeCredentialField(value);
  if (!field || !isRecord(value)) return undefined;
  return {
    ...field,
    location: value.location === "secretExtra" ? "secretExtra" : value.location === "extra" ? "extra" : undefined,
    defaultValue: optionalString(value.defaultValue),
  };
}

function normalizeAuthDefinition(value: unknown): ConnectorAuthDefinition | undefined {
  if (!isRecord(value)) return undefined;
  const type = normalizeAuthType(value.type);
  if (type === "no_auth") return { type };
  if (type === "api_key") {
    return {
      type,
      label: optionalString(value.label),
      placeholder: optionalString(value.placeholder),
      description: optionalString(value.description),
      extraFields: Array.isArray(value.extraFields)
        ? value.extraFields.map(normalizeCredentialField).filter((field): field is ConnectorCredentialField => Boolean(field))
        : [],
    };
  }
  if (type === "custom_credential") {
    return {
      type,
      fields: Array.isArray(value.fields)
        ? value.fields.map(normalizeCredentialField).filter((field): field is ConnectorCredentialField => Boolean(field))
        : [],
    };
  }
  if (type === "oauth2") {
    return {
      type,
      scopes: stringArray(value.scopes),
      clientConfigFields: Array.isArray(value.clientConfigFields)
        ? value.clientConfigFields.map(normalizeOAuthClientField).filter((field): field is ConnectorOAuthClientField => Boolean(field))
        : [],
    };
  }
  return undefined;
}

function normalizeProviderSummary(value: unknown): ConnectorProviderSummary | undefined {
  if (!isRecord(value)) return undefined;
  const service = optionalString(value.service);
  const displayName = optionalString(value.displayName);
  if (!service || !displayName) return undefined;
  const authTypes = stringArray(value.authTypes)
    .map(normalizeAuthType)
    .filter((type): type is ConnectorAuthType => Boolean(type));
  return {
    service,
    displayName,
    description: optionalString(value.description),
    categories: stringArray(value.categories),
    authTypes,
    iconUrl: optionalString(value.iconUrl),
    actionCount: Array.isArray(value.actions) ? value.actions.length : 0,
  };
}

function normalizeActionDefinition(value: unknown): ConnectorActionDefinition | undefined {
  if (!isRecord(value)) return undefined;
  const id = optionalString(value.id);
  const name = optionalString(value.name) || id?.split(".").at(-1);
  if (!id || !name) return undefined;
  const execution = isRecord(value.execution) ? value.execution : undefined;
  return {
    id,
    name,
    description: optionalString(value.description),
    requiredScopes: stringArray(value.requiredScopes),
    providerPermissions: stringArray(value.providerPermissions),
    inputSchema: isRecord(value.inputSchema) ? value.inputSchema : undefined,
    outputSchema: isRecord(value.outputSchema) ? value.outputSchema : undefined,
    execution: execution ? {
      locallyExecutable: execution.locallyExecutable === true,
      catalogOnly: execution.catalogOnly === true,
      requiredAuthTypes: stringArray(execution.requiredAuthTypes)
        .map(normalizeAuthType)
        .filter((type): type is ConnectorAuthType => Boolean(type)),
      noAuthRunnable: execution.noAuthRunnable === true,
      needsCredential: execution.needsCredential === true,
    } : undefined,
  };
}

function normalizeProviderDetail(value: unknown): ConnectorProviderDetail {
  const summary = normalizeProviderSummary(value);
  if (!summary || !isRecord(value)) throw new OpenConnectorError("OpenConnector 返回了无效的 Connector 定义");
  return {
    ...summary,
    auth: Array.isArray(value.auth)
      ? value.auth.map(normalizeAuthDefinition).filter((auth): auth is ConnectorAuthDefinition => Boolean(auth))
      : [],
    actions: Array.isArray(value.actions)
      ? value.actions.map(normalizeActionDefinition).filter((action): action is ConnectorActionDefinition => Boolean(action))
      : [],
  };
}

async function readProviderSummaries() {
  if (providerCache && providerCache.expiresAt > Date.now()) return providerCache.providers;
  const payload = await requestOpenConnector<unknown[]>("api/providers");
  if (!Array.isArray(payload)) throw new OpenConnectorError("OpenConnector 返回了无效的 Connector 列表");
  const providers = payload
    .map(normalizeProviderSummary)
    .filter((provider): provider is ConnectorProviderSummary => Boolean(provider))
    .sort((left, right) => left.displayName.localeCompare(right.displayName, "zh-CN"));
  providerCache = { expiresAt: Date.now() + PROVIDER_CACHE_TTL_MS, providers };
  return providers;
}

export function resetOpenConnectorProviderCache() {
  providerCache = undefined;
}

export async function listConnectorProviders(input: {
  query?: string;
  category?: string;
  authType?: string;
  page?: number;
  limit?: number;
} = {}): Promise<ConnectorProvidersPage> {
  const providers = await readProviderSummaries();
  const query = input.query?.trim().toLocaleLowerCase("zh-CN") || "";
  const category = input.category?.trim() || "";
  const authType = normalizeAuthType(input.authType);
  const filtered = providers.filter((provider) => {
    const matchesQuery = !query || [provider.displayName, provider.service, provider.description || ""]
      .some((value) => value.toLocaleLowerCase("zh-CN").includes(query));
    return matchesQuery
      && (!category || provider.categories.includes(category))
      && (!authType || provider.authTypes.includes(authType));
  });
  const page = Math.max(1, Math.floor(input.page || 1));
  const limit = Math.min(50, Math.max(1, Math.floor(input.limit || 24)));
  const offset = (page - 1) * limit;
  return {
    items: filtered.slice(offset, offset + limit),
    total: filtered.length,
    page,
    limit,
    categories: Array.from(new Set(providers.flatMap((provider) => provider.categories))).sort((left, right) => left.localeCompare(right, "zh-CN")),
    authTypes: Array.from(new Set(providers.flatMap((provider) => provider.authTypes))),
  };
}

export async function getConnectorProviderSummaries(services: string[]) {
  const requested = new Set(services);
  return (await readProviderSummaries()).filter((provider) => requested.has(provider.service));
}

function assertService(service: string) {
  if (!/^[a-z0-9][a-z0-9_-]{0,127}$/.test(service)) {
    throw new OpenConnectorError("无效的 Connector Service ID", 400);
  }
  return service;
}

export async function getConnectorProvider(service: string): Promise<ConnectorProviderDetail> {
  const safeService = assertService(service);
  return normalizeProviderDetail(await requestOpenConnector(`api/providers/${encodeURIComponent(safeService)}`));
}

function normalizeConnection(value: unknown): ConnectorConnection | undefined {
  if (!isRecord(value)) return undefined;
  const service = optionalString(value.service);
  const connectionName = optionalString(value.connectionName) || "default";
  const authType = normalizeAuthType(value.authType);
  if (!service || !authType) return undefined;
  const profile = isRecord(value.profile) ? value.profile : {};
  return {
    id: optionalString(value.id) || `${service}:${connectionName}`,
    service,
    connectionName,
    authType,
    accessMode: authType === "no_auth" ? "no_auth" : "global",
    configured: value.configured === true,
    virtual: value.virtual === true,
    default: value.default === true,
    profile: {
      accountId: optionalString(profile.accountId) || `${service}:${connectionName}`,
      displayName: optionalString(profile.displayName) || connectionName,
      grantedScopes: stringArray(profile.grantedScopes),
    },
  };
}

export async function listConnectorConnections(): Promise<ConnectorConnectionsSnapshot> {
  const payload = await requestOpenConnector<unknown[]>("api/connections");
  if (!Array.isArray(payload)) throw new OpenConnectorError("OpenConnector 返回了无效的连接列表");
  return {
    connections: payload.map(normalizeConnection).filter((connection): connection is ConnectorConnection => Boolean(connection)),
    updatedAt: new Date().toISOString(),
  };
}

export async function saveConnectorConnection(service: string, input: ConnectorConnectionInput) {
  const safeService = assertService(service);
  return normalizeConnection(await requestOpenConnector(`api/connections/${encodeURIComponent(safeService)}`, {
    method: "PUT",
    body: JSON.stringify(input),
  }));
}

export async function deleteConnectorConnection(service: string, connectionName: string) {
  const safeService = assertService(service);
  return requestOpenConnector(`api/connections/${encodeURIComponent(safeService)}`, {
    method: "DELETE",
    body: JSON.stringify({ connectionName }),
  });
}

function normalizeOAuthConfig(value: unknown): ConnectorOAuthConfig | undefined {
  if (!isRecord(value)) return undefined;
  const service = optionalString(value.service);
  const expectedRedirectUri = optionalString(value.expectedRedirectUri);
  if (!service || !expectedRedirectUri) return undefined;
  return {
    service,
    configured: value.configured === true,
    clientId: optionalString(value.clientId) || null,
    expectedRedirectUri,
  };
}

export async function getConnectorOAuthConfig(service: string): Promise<ConnectorOAuthConfig> {
  const safeService = assertService(service);
  const payload = await requestOpenConnector<unknown[]>("api/oauth/configs");
  const config = Array.isArray(payload)
    ? payload.map(normalizeOAuthConfig).find((item) => item?.service === safeService)
    : undefined;
  if (!config) throw new OpenConnectorError("该 Connector 不支持 OAuth 2.0", 404);
  return config;
}

export async function saveConnectorOAuthConfig(service: string, input: ConnectorOAuthConfigInput): Promise<ConnectorOAuthConfig> {
  const safeService = assertService(service);
  const config = normalizeOAuthConfig(await requestOpenConnector(`api/oauth/configs/${encodeURIComponent(safeService)}`, {
    method: "PUT",
    body: JSON.stringify(input),
  }));
  if (!config) throw new OpenConnectorError("OpenConnector 返回了无效的 OAuth 配置");
  return config;
}

export async function startConnectorOAuthAuthorization(
  service: string,
  connectionName: string,
  actionIds?: string[],
): Promise<ConnectorOAuthAuthorization> {
  const safeService = assertService(service);
  const payload = await requestOpenConnector<Record<string, unknown>>("api/oauth/authorizations", {
    method: "POST",
    body: JSON.stringify({ service: safeService, connectionName, actionIds }),
  });
  const authorizationUrl = optionalString(payload.authorizationUrl);
  if (!authorizationUrl) throw new OpenConnectorError("OpenConnector 未返回 OAuth 授权地址");
  return { service: safeService, authorizationUrl };
}
