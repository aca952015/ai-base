import { createCipheriv, createDecipheriv, createHash, randomBytes, randomUUID } from "node:crypto";

import { Pool, type QueryResultRow } from "pg";

import type {
  EnterpriseIntegrationGroup,
  EnterpriseIntegrationPlatform,
  EnterpriseIntegrationsSnapshot,
  EmployeeConnectorBinding,
  EmployeeConnectorBindingStatus,
  EmployeeIntegrationApplication,
  EmployeeIntegrationsSnapshot,
  IntegrationActionOption,
  IntegrationApplication,
} from "../control-plane/integrations";
import {
  classifyConnectorConnections,
  connectorConnectionKey,
  type ConnectorConnectionsSnapshot,
} from "../control-plane/connectors";
import type { ConsoleIdentity } from "./console-identity";
import {
  deleteConnectorConnection,
  getConnectorProvider,
  listConnectorConnections,
  saveConnectorOAuthConfig,
  startConnectorOAuthAuthorization,
} from "./open-connector";

const APP_ID_MAX_LENGTH = 255;
const APP_NAME_MAX_LENGTH = 120;
const APP_NOTE_MAX_LENGTH = 500;
const APP_SECRET_MAX_LENGTH = 4_096;
const ACTION_IDS_MAX_COUNT = 1_000;
const ENCRYPTION_VERSION = "v1";
const FEISHU_DEFAULT_ACTION_IDS = [
  "feishu.get_current_user",
  "feishu.get_document",
  "feishu.get_document_content",
  "feishu.list_document_blocks",
  "feishu.list_bitable_tables",
  "feishu.list_bitable_fields",
  "feishu.search_bitable_records",
];

type PlatformDefinition = Omit<EnterpriseIntegrationGroup, "applications"> & {
  service?: string;
  supportsPersonalOAuth: boolean;
};

const platformDefinitions: PlatformDefinition[] = [
  {
    platform: "feishu",
    displayName: "飞书",
    description: "管理飞书开放平台应用凭据。",
    service: "feishu",
    supportsPersonalOAuth: true,
    actions: [],
    defaultActionIds: FEISHU_DEFAULT_ACTION_IDS,
    oauthBaseScopes: [],
  },
  {
    platform: "wecom",
    displayName: "企微",
    description: "管理企微自建应用凭据。",
    supportsPersonalOAuth: false,
    actions: [],
    defaultActionIds: [],
    oauthBaseScopes: [],
  },
  {
    platform: "dingtalk",
    displayName: "钉钉",
    description: "管理钉钉开放平台应用凭据。",
    supportsPersonalOAuth: false,
    actions: [],
    defaultActionIds: [],
    oauthBaseScopes: [],
  },
];

const allowedPlatforms = new Set(platformDefinitions.map((definition) => definition.platform));

type IntegrationApplicationRow = QueryResultRow & {
  id: string;
  platform: EnterpriseIntegrationPlatform;
  app_name: string;
  app_id: string;
  note: string;
  action_ids: unknown;
  active: boolean;
  app_secret_ciphertext?: string;
  created_at: Date | string;
  updated_at: Date | string;
};

type EmployeeConnectorBindingRow = QueryResultRow & {
  id: string;
  application_id: string;
  platform: EnterpriseIntegrationPlatform;
  service: string;
  connection_name: string;
  principal_email: string;
  principal_name: string;
  status: EmployeeConnectorBindingStatus;
  display_name: string | null;
  account_id: string | null;
  error_message: string | null;
  connected_at: Date | string | null;
  updated_at: Date | string;
};

declare global {
  var aiBaseIntegrationPool: Pool | undefined;
  var aiBaseIntegrationSchemaPromise: Promise<void> | undefined;
}

export class IntegrationStoreError extends Error {
  readonly status: number;

  constructor(message: string, status = 500) {
    super(message);
    this.name = "IntegrationStoreError";
    this.status = status;
  }
}

function databaseUrl() {
  const value = process.env.DATABASE_URL?.trim();
  if (!value) throw new IntegrationStoreError("AI Console 数据库连接未配置", 503);
  return value;
}

function getPool() {
  if (!globalThis.aiBaseIntegrationPool) {
    globalThis.aiBaseIntegrationPool = new Pool({
      connectionString: databaseUrl(),
      max: 5,
      idleTimeoutMillis: 30_000,
      connectionTimeoutMillis: 5_000,
    });
  }
  return globalThis.aiBaseIntegrationPool;
}

async function ensureSchema() {
  if (!globalThis.aiBaseIntegrationSchemaPromise) {
    globalThis.aiBaseIntegrationSchemaPromise = getPool().query(`
      CREATE TABLE IF NOT EXISTS integration_applications (
        id UUID PRIMARY KEY,
        platform TEXT NOT NULL CHECK (platform IN ('feishu', 'wecom', 'dingtalk')),
        app_name TEXT NOT NULL,
        app_id TEXT NOT NULL,
        note TEXT NOT NULL DEFAULT '',
        action_ids JSONB NOT NULL DEFAULT '[]'::JSONB,
        active BOOLEAN NOT NULL DEFAULT FALSE,
        app_secret_ciphertext TEXT NOT NULL,
        created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
        updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
        UNIQUE (platform, app_id)
      );
      ALTER TABLE integration_applications ADD COLUMN IF NOT EXISTS app_name TEXT;
      UPDATE integration_applications
      SET app_name = app_id
      WHERE app_name IS NULL OR BTRIM(app_name) = '';
      ALTER TABLE integration_applications ALTER COLUMN app_name SET NOT NULL;
      ALTER TABLE integration_applications ADD COLUMN IF NOT EXISTS note TEXT;
      UPDATE integration_applications SET note = '' WHERE note IS NULL;
      ALTER TABLE integration_applications ALTER COLUMN note SET DEFAULT '';
      ALTER TABLE integration_applications ALTER COLUMN note SET NOT NULL;
      ALTER TABLE integration_applications
        ADD COLUMN IF NOT EXISTS action_ids JSONB NOT NULL DEFAULT '[]'::JSONB;
      UPDATE integration_applications
      SET action_ids = '[
        "feishu.get_current_user",
        "feishu.get_document",
        "feishu.get_document_content",
        "feishu.list_document_blocks",
        "feishu.list_bitable_tables",
        "feishu.list_bitable_fields",
        "feishu.search_bitable_records"
      ]'::JSONB
      WHERE platform = 'feishu' AND action_ids = '[]'::JSONB;
      ALTER TABLE integration_applications ADD COLUMN IF NOT EXISTS active BOOLEAN NOT NULL DEFAULT FALSE;
      UPDATE integration_applications AS application
      SET active = TRUE
      WHERE application.id IN (
        SELECT DISTINCT ON (candidate.platform) candidate.id
        FROM integration_applications AS candidate
        WHERE NOT EXISTS (
          SELECT 1
          FROM integration_applications AS enabled
          WHERE enabled.platform = candidate.platform AND enabled.active
        )
        ORDER BY candidate.platform, candidate.created_at, candidate.id
      );
      CREATE UNIQUE INDEX IF NOT EXISTS integration_applications_one_active_per_platform
        ON integration_applications(platform) WHERE active;
      CREATE TABLE IF NOT EXISTS employee_connector_bindings (
        id UUID PRIMARY KEY,
        application_id UUID NOT NULL REFERENCES integration_applications(id) ON DELETE RESTRICT,
        principal_issuer TEXT NOT NULL,
        principal_subject TEXT NOT NULL,
        principal_email TEXT NOT NULL,
        principal_name TEXT NOT NULL,
        platform TEXT NOT NULL CHECK (platform IN ('feishu', 'wecom', 'dingtalk')),
        service TEXT NOT NULL,
        connection_name TEXT NOT NULL,
        status TEXT NOT NULL CHECK (status IN ('pending', 'connected', 'error', 'revoked')),
        display_name TEXT,
        account_id TEXT,
        error_message TEXT,
        connected_at TIMESTAMPTZ,
        created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
        updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
        UNIQUE (principal_issuer, principal_subject, service),
        UNIQUE (service, connection_name)
      );
      CREATE INDEX IF NOT EXISTS employee_connector_bindings_principal_idx
        ON employee_connector_bindings(principal_issuer, principal_subject, status)
    `).then(() => undefined).catch((error: unknown) => {
      globalThis.aiBaseIntegrationSchemaPromise = undefined;
      throw error;
    });
  }
  return globalThis.aiBaseIntegrationSchemaPromise;
}

function encryptionKey() {
  const secret = process.env.AI_CONSOLE_SECRET_ENCRYPTION_KEY?.trim();
  if (!secret || secret.length < 32) {
    throw new IntegrationStoreError("AI Console 集成密钥未配置或长度不足 32 个字符", 503);
  }
  return createHash("sha256").update(secret, "utf8").digest();
}

export function encryptIntegrationSecret(secret: string) {
  const iv = randomBytes(12);
  const cipher = createCipheriv("aes-256-gcm", encryptionKey(), iv);
  const ciphertext = Buffer.concat([cipher.update(secret, "utf8"), cipher.final()]);
  const tag = cipher.getAuthTag();
  return [
    ENCRYPTION_VERSION,
    iv.toString("base64url"),
    tag.toString("base64url"),
    ciphertext.toString("base64url"),
  ].join(".");
}

export function decryptIntegrationSecret(payload: string) {
  const [version, ivValue, tagValue, ciphertextValue, ...extra] = payload.split(".");
  if (
    version !== ENCRYPTION_VERSION
    || !ivValue
    || !tagValue
    || !ciphertextValue
    || extra.length
  ) {
    throw new IntegrationStoreError("集成应用密钥格式无效", 500);
  }
  try {
    const decipher = createDecipheriv("aes-256-gcm", encryptionKey(), Buffer.from(ivValue, "base64url"));
    decipher.setAuthTag(Buffer.from(tagValue, "base64url"));
    return Buffer.concat([
      decipher.update(Buffer.from(ciphertextValue, "base64url")),
      decipher.final(),
    ]).toString("utf8");
  } catch {
    throw new IntegrationStoreError("无法解密集成应用密钥", 500);
  }
}

function normalizePlatform(value: unknown): EnterpriseIntegrationPlatform {
  if (typeof value !== "string" || !allowedPlatforms.has(value as EnterpriseIntegrationPlatform)) {
    throw new IntegrationStoreError("仅支持飞书、企微和钉钉应用", 400);
  }
  return value as EnterpriseIntegrationPlatform;
}

function requiredValue(value: unknown, label: string, maxLength: number) {
  const normalized = typeof value === "string" ? value.trim() : "";
  if (!normalized) throw new IntegrationStoreError(`${label} 不能为空`, 400);
  if (normalized.length > maxLength) throw new IntegrationStoreError(`${label} 长度不能超过 ${maxLength} 个字符`, 400);
  return normalized;
}

function requiredSecret(value: unknown) {
  if (typeof value !== "string" || !value.trim()) {
    throw new IntegrationStoreError("App Secret 不能为空", 400);
  }
  if (value.length > APP_SECRET_MAX_LENGTH) {
    throw new IntegrationStoreError(`App Secret 长度不能超过 ${APP_SECRET_MAX_LENGTH} 个字符`, 400);
  }
  return value;
}

function optionalValue(value: unknown, label: string, maxLength: number) {
  const normalized = typeof value === "string" ? value.trim() : "";
  if (normalized.length > maxLength) throw new IntegrationStoreError(`${label}长度不能超过 ${maxLength} 个字符`, 400);
  return normalized;
}

function optionalSecret(value: unknown) {
  if (value === undefined || value === null || value === "" || (typeof value === "string" && !value.trim())) {
    return undefined;
  }
  return requiredSecret(value);
}

function storedActionIds(value: unknown) {
  return Array.isArray(value)
    ? [...new Set(value.filter((item): item is string => typeof item === "string" && Boolean(item.trim()))
      .map((item) => item.trim()))]
    : [];
}

function serializeApplication(row: IntegrationApplicationRow): IntegrationApplication {
  return {
    id: row.id,
    platform: row.platform,
    name: row.app_name,
    appId: row.app_id,
    note: row.note,
    actionIds: storedActionIds(row.action_ids),
    active: row.active,
    secretConfigured: true,
    createdAt: new Date(row.created_at).toISOString(),
    updatedAt: new Date(row.updated_at).toISOString(),
  };
}

type IntegrationActionCatalog = {
  actions: IntegrationActionOption[];
  defaultActionIds: string[];
  oauthBaseScopes: string[];
};

async function integrationActionCatalog(platform: EnterpriseIntegrationPlatform): Promise<IntegrationActionCatalog> {
  const definition = platformDefinition(platform);
  if (!definition.service) {
    return {
      actions: [],
      defaultActionIds: [],
      oauthBaseScopes: [],
    };
  }

  const provider = await getConnectorProvider(definition.service);
  const actions = provider.actions
    .filter((action) => action.execution?.catalogOnly !== true)
    .map((action) => ({
      id: action.id,
      name: action.name,
      description: action.description,
      providerPermissions: action.providerPermissions,
    }))
    .sort((left, right) => left.name.localeCompare(right.name, "zh-CN"));
  const actionPermissions = new Set(actions.flatMap((action) => action.providerPermissions));
  const oauth = provider.auth.find((auth) => auth.type === "oauth2");
  const availableIds = new Set(actions.map((action) => action.id));
  return {
    actions,
    defaultActionIds: definition.defaultActionIds.filter((actionId) => availableIds.has(actionId)),
    oauthBaseScopes: oauth?.type === "oauth2"
      ? oauth.scopes.filter((scope) => !actionPermissions.has(scope))
      : [],
  };
}

async function normalizeIntegrationActionIds(
  platform: EnterpriseIntegrationPlatform,
  value: unknown,
  fallback: string[],
) {
  const actionIds = value === undefined
    ? fallback
    : Array.isArray(value)
      ? [...new Set(value.map((item) => typeof item === "string" ? item.trim() : "").filter(Boolean))]
      : undefined;
  if (!actionIds) throw new IntegrationStoreError("Action 配置必须是字符串数组", 400);
  if (actionIds.length > ACTION_IDS_MAX_COUNT) {
    throw new IntegrationStoreError(`最多选择 ${ACTION_IDS_MAX_COUNT} 个 Action`, 400);
  }

  const catalog = await integrationActionCatalog(platform);
  if (catalog.actions.length > 0 && actionIds.length === 0) {
    throw new IntegrationStoreError("至少选择一个 Action", 400);
  }
  const availableIds = new Set(catalog.actions.map((action) => action.id));
  const unknownIds = actionIds.filter((actionId) => !availableIds.has(actionId));
  if (unknownIds.length > 0) {
    throw new IntegrationStoreError(`包含不可用的 Action：${unknownIds.slice(0, 3).join("、")}`, 400);
  }
  return actionIds;
}

export function buildEnterpriseIntegrationsSnapshot(
  applications: IntegrationApplication[],
  updatedAt = new Date().toISOString(),
  actionCatalogs: Partial<Record<EnterpriseIntegrationPlatform, IntegrationActionCatalog>> = {},
): EnterpriseIntegrationsSnapshot {
  return {
    groups: platformDefinitions.map((definition) => ({
      platform: definition.platform,
      displayName: definition.displayName,
      description: definition.description,
      actions: actionCatalogs[definition.platform]?.actions ?? [],
      defaultActionIds: actionCatalogs[definition.platform]?.defaultActionIds ?? definition.defaultActionIds,
      oauthBaseScopes: actionCatalogs[definition.platform]?.oauthBaseScopes ?? [],
      applications: applications.filter((application) => application.platform === definition.platform),
    })),
    updatedAt,
  };
}

export async function getEnterpriseIntegrations(): Promise<EnterpriseIntegrationsSnapshot> {
  await ensureSchema();
  const [result, catalogs] = await Promise.all([
    getPool().query<IntegrationApplicationRow>(`
      SELECT id, platform, app_name, app_id, note, action_ids, active, created_at, updated_at
      FROM integration_applications
      ORDER BY platform, created_at, app_name, app_id
    `),
    Promise.all(platformDefinitions.map(async (definition) => (
      [definition.platform, await integrationActionCatalog(definition.platform)] as const
    ))),
  ]);
  return buildEnterpriseIntegrationsSnapshot(
    result.rows.map(serializeApplication),
    new Date().toISOString(),
    Object.fromEntries(catalogs),
  );
}

export async function createIntegrationApplication(input: {
  platform: unknown;
  name: unknown;
  appId: unknown;
  note?: unknown;
  appSecret: unknown;
  actionIds?: unknown;
}) {
  await ensureSchema();
  const platform = normalizePlatform(input.platform);
  const name = requiredValue(input.name, "应用名称", APP_NAME_MAX_LENGTH);
  const appId = requiredValue(input.appId, "App ID", APP_ID_MAX_LENGTH);
  const note = optionalValue(input.note, "备注", APP_NOTE_MAX_LENGTH);
  const appSecret = requiredSecret(input.appSecret);
  const definition = platformDefinition(platform);
  const actionIds = await normalizeIntegrationActionIds(platform, input.actionIds, definition.defaultActionIds);
  try {
    const result = await getPool().query<IntegrationApplicationRow>(`
      INSERT INTO integration_applications (
        id, platform, app_name, app_id, note, action_ids, active, app_secret_ciphertext
      )
      VALUES (
        $1, $2, $3, $4, $5, $6::JSONB,
        NOT EXISTS (SELECT 1 FROM integration_applications WHERE platform = $2 AND active),
        $7
      )
      RETURNING id, platform, app_name, app_id, note, action_ids, active, created_at, updated_at
    `, [
      randomUUID(),
      platform,
      name,
      appId,
      note,
      JSON.stringify(actionIds),
      encryptIntegrationSecret(appSecret),
    ]);
    return serializeApplication(result.rows[0]);
  } catch (error) {
    if (isUniqueViolation(error)) throw new IntegrationStoreError("该平台下已存在相同 App ID", 409);
    throw error;
  }
}

export async function updateIntegrationApplication(id: string, input: {
  name: unknown;
  appId: unknown;
  note?: unknown;
  appSecret?: unknown;
  actionIds?: unknown;
}) {
  await ensureSchema();
  const safeId = requiredUuid(id);
  const current = await getPool().query<IntegrationApplicationRow>(`
    SELECT id, platform, app_name, app_id, note, action_ids, active, created_at, updated_at
    FROM integration_applications
    WHERE id = $1
  `, [safeId]);
  if (!current.rows[0]) throw new IntegrationStoreError("应用配置不存在", 404);
  const name = requiredValue(input.name, "应用名称", APP_NAME_MAX_LENGTH);
  const appId = requiredValue(input.appId, "App ID", APP_ID_MAX_LENGTH);
  const note = optionalValue(input.note, "备注", APP_NOTE_MAX_LENGTH);
  const appSecret = optionalSecret(input.appSecret);
  const actionIds = await normalizeIntegrationActionIds(
    current.rows[0].platform,
    input.actionIds,
    storedActionIds(current.rows[0].action_ids),
  );
  const parameters = appSecret
    ? [safeId, name, appId, note, JSON.stringify(actionIds), encryptIntegrationSecret(appSecret)]
    : [safeId, name, appId, note, JSON.stringify(actionIds)];
  const secretAssignment = appSecret ? ", app_secret_ciphertext = $6" : "";
  try {
    const result = await getPool().query<IntegrationApplicationRow>(`
      UPDATE integration_applications
      SET app_name = $2, app_id = $3, note = $4, action_ids = $5::JSONB${secretAssignment}, updated_at = NOW()
      WHERE id = $1
      RETURNING id, platform, app_name, app_id, note, action_ids, active, created_at, updated_at
    `, parameters);
    if (!result.rows[0]) throw new IntegrationStoreError("应用配置不存在", 404);
    return serializeApplication(result.rows[0]);
  } catch (error) {
    if (isUniqueViolation(error)) throw new IntegrationStoreError("该平台下已存在相同 App ID", 409);
    throw error;
  }
}

export async function deleteIntegrationApplication(id: string) {
  await ensureSchema();
  try {
    const result = await getPool().query(
      "DELETE FROM integration_applications WHERE id = $1",
      [requiredUuid(id)],
    );
    if (!result.rowCount) throw new IntegrationStoreError("应用配置不存在", 404);
    return { deleted: true };
  } catch (error) {
    if (isForeignKeyViolation(error)) {
      throw new IntegrationStoreError("该应用仍有员工账号绑定，不能删除", 409);
    }
    throw error;
  }
}

async function applicationWithSecret(id: string) {
  const result = await getPool().query<IntegrationApplicationRow>(`
    SELECT id, platform, app_name, app_id, note, action_ids, active, app_secret_ciphertext, created_at, updated_at
    FROM integration_applications
    WHERE id = $1
  `, [requiredUuid(id)]);
  const row = result.rows[0];
  if (!row?.app_secret_ciphertext) throw new IntegrationStoreError("应用配置不存在", 404);
  return row;
}

async function syncApplicationOAuthClient(row: IntegrationApplicationRow) {
  const definition = platformDefinitions.find((item) => item.platform === row.platform);
  if (!definition?.service || !definition.supportsPersonalOAuth || !row.app_secret_ciphertext) return;
  await saveConnectorOAuthConfig(definition.service, {
    clientId: row.app_id,
    clientSecret: decryptIntegrationSecret(row.app_secret_ciphertext),
    extra: {},
    secretExtra: {},
  });
}

export async function activateIntegrationApplication(id: string) {
  await ensureSchema();
  const row = await applicationWithSecret(id);
  if (!row.active) {
    const binding = await getPool().query(`
      SELECT 1
      FROM employee_connector_bindings
      WHERE platform = $1 AND status IN ('pending', 'connected')
      LIMIT 1
    `, [row.platform]);
    if (binding.rowCount) {
      throw new IntegrationStoreError("该平台已有员工账号绑定，不能切换启用应用", 409);
    }
  }

  await syncApplicationOAuthClient(row);
  const client = await getPool().connect();
  try {
    await client.query("BEGIN");
    await client.query(
      "UPDATE integration_applications SET active = FALSE, updated_at = NOW() WHERE platform = $1 AND id <> $2",
      [row.platform, row.id],
    );
    const result = await client.query<IntegrationApplicationRow>(`
      UPDATE integration_applications
      SET active = TRUE, updated_at = NOW()
      WHERE id = $1
      RETURNING id, platform, app_name, app_id, note, action_ids, active, created_at, updated_at
    `, [row.id]);
    await client.query("COMMIT");
    return serializeApplication(result.rows[0]);
  } catch (error) {
    await client.query("ROLLBACK");
    throw error;
  } finally {
    client.release();
  }
}

function serializeBinding(row: EmployeeConnectorBindingRow): EmployeeConnectorBinding {
  return {
    id: row.id,
    applicationId: row.application_id,
    platform: row.platform,
    service: row.service,
    connectionName: row.connection_name,
    status: row.status,
    displayName: row.display_name || undefined,
    accountId: row.account_id || undefined,
    errorMessage: row.error_message || undefined,
    connectedAt: row.connected_at ? new Date(row.connected_at).toISOString() : undefined,
    updatedAt: new Date(row.updated_at).toISOString(),
  };
}

function employeeConnectionName(identity: ConsoleIdentity, service: string) {
  const digest = createHash("sha256")
    .update(`${identity.principalIssuer}\0${identity.principalSubject}\0${service}`, "utf8")
    .digest("hex")
    .slice(0, 40);
  return `usr_${digest}`;
}

async function reconcileEmployeeBindings(identity: ConsoleIdentity) {
  const rows = await getPool().query<EmployeeConnectorBindingRow>(`
    SELECT id, application_id, platform, service, connection_name, status,
           display_name, account_id, error_message, connected_at, updated_at
    FROM employee_connector_bindings
    WHERE principal_issuer = $1 AND principal_subject = $2 AND status <> 'revoked'
  `, [identity.principalIssuer, identity.principalSubject]);
  if (!rows.rowCount) return [];

  const snapshot = await listConnectorConnections();
  const connections = new Map(
    snapshot.connections
      .filter((connection) => connection.configured)
      .map((connection) => [`${connection.service}\0${connection.connectionName}`, connection]),
  );

  for (const row of rows.rows) {
    const connection = connections.get(`${row.service}\0${row.connection_name}`);
    if (connection && row.status !== "connected") {
      await getPool().query(`
        UPDATE employee_connector_bindings
        SET status = 'connected', display_name = $2, account_id = $3,
            error_message = NULL, connected_at = COALESCE(connected_at, NOW()), updated_at = NOW()
        WHERE id = $1
      `, [row.id, connection.profile.displayName, connection.profile.accountId]);
    } else if (!connection && row.status === "connected") {
      await getPool().query(`
        UPDATE employee_connector_bindings
        SET status = 'revoked', error_message = 'OpenConnector 中的个人连接已不存在', updated_at = NOW()
        WHERE id = $1
      `, [row.id]);
    }
  }

  const refreshed = await getPool().query<EmployeeConnectorBindingRow>(`
    SELECT id, application_id, platform, service, connection_name, status,
           display_name, account_id, error_message, connected_at, updated_at
    FROM employee_connector_bindings
    WHERE principal_issuer = $1 AND principal_subject = $2 AND status <> 'revoked'
  `, [identity.principalIssuer, identity.principalSubject]);
  return refreshed.rows;
}

export async function getEmployeeIntegrations(identity: ConsoleIdentity): Promise<EmployeeIntegrationsSnapshot> {
  await ensureSchema();
  const [applications, bindings] = await Promise.all([
    getPool().query<IntegrationApplicationRow>(`
      SELECT id, platform, app_name, app_id, note, action_ids, active, created_at, updated_at
      FROM integration_applications
      ORDER BY created_at, app_name, app_id
    `),
    reconcileEmployeeBindings(identity),
  ]);
  return buildEmployeeIntegrationsSnapshot(
    applications.rows.map(serializeApplication),
    bindings.map(serializeBinding),
    { name: identity.name, email: identity.email },
  );
}

export async function listClassifiedConnectorConnections(): Promise<ConnectorConnectionsSnapshot> {
  await ensureSchema();
  const [snapshot, bindings] = await Promise.all([
    listConnectorConnections(),
    getPool().query<Pick<
      EmployeeConnectorBindingRow,
      "service" | "connection_name" | "principal_email" | "principal_name"
    >>(`
      SELECT service, connection_name, principal_email, principal_name
      FROM employee_connector_bindings
      WHERE status <> 'revoked'
    `),
  ]);
  const localAccountsByConnectionKey = new Map(
    bindings.rows.map((binding) => [
      connectorConnectionKey(binding.service, binding.connection_name),
      {
        name: binding.principal_name,
        email: binding.principal_email,
      },
    ]),
  );
  return {
    ...snapshot,
    connections: classifyConnectorConnections(snapshot.connections, localAccountsByConnectionKey),
  };
}

export function buildEmployeeIntegrationsSnapshot(
  applications: IntegrationApplication[],
  bindings: EmployeeConnectorBinding[],
  identity: EmployeeIntegrationsSnapshot["identity"],
  updatedAt = new Date().toISOString(),
): EmployeeIntegrationsSnapshot {
  const bindingByApplication = new Map(
    bindings.map((binding) => [binding.applicationId, binding]),
  );
  const employeeApplications: EmployeeIntegrationApplication[] = platformDefinitions.flatMap(
    (definition) => applications
      .filter((application) => application.platform === definition.platform)
      .map((application) => ({
        id: application.id,
        platform: application.platform,
        name: application.name,
        appId: application.appId,
        note: application.note,
        active: application.active,
        platformDisplayName: definition.displayName,
        supportsPersonalOAuth: definition.supportsPersonalOAuth,
        binding: bindingByApplication.get(application.id),
      })),
  );
  return {
    identity,
    applications: employeeApplications,
    updatedAt,
  };
}

function platformDefinition(platform: string) {
  const definition = platformDefinitions.find((item) => item.platform === platform);
  if (!definition) throw new IntegrationStoreError("不支持的集成平台", 400);
  return definition;
}

export async function startEmployeeIntegrationAuthorization(
  identity: ConsoleIdentity,
  applicationId: string,
) {
  await ensureSchema();
  const row = await applicationWithSecret(applicationId);
  const definition = platformDefinition(row.platform);
  if (!definition.supportsPersonalOAuth || !definition.service) {
    throw new IntegrationStoreError("当前 OpenConnector 版本暂不支持该平台的个人 OAuth", 409);
  }
  if (!row.active) {
    throw new IntegrationStoreError("管理员尚未启用该应用配置", 409);
  }

  await syncApplicationOAuthClient(row);
  const actionIds = await normalizeIntegrationActionIds(
    row.platform,
    row.action_ids,
    platformDefinition(row.platform).defaultActionIds,
  );
  const connectionName = employeeConnectionName(identity, definition.service);
  const bindingId = randomUUID();
  await getPool().query(`
    INSERT INTO employee_connector_bindings (
      id, application_id, principal_issuer, principal_subject, principal_email,
      principal_name, platform, service, connection_name, status
    )
    VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, 'pending')
    ON CONFLICT (principal_issuer, principal_subject, service)
    DO UPDATE SET
      application_id = EXCLUDED.application_id,
      principal_email = EXCLUDED.principal_email,
      principal_name = EXCLUDED.principal_name,
      platform = EXCLUDED.platform,
      connection_name = EXCLUDED.connection_name,
      status = 'pending',
      display_name = NULL,
      account_id = NULL,
      error_message = NULL,
      connected_at = NULL,
      updated_at = NOW()
  `, [
    bindingId,
    row.id,
    identity.principalIssuer,
    identity.principalSubject,
    identity.email,
    identity.name,
    definition.platform,
    definition.service,
    connectionName,
  ]);

  try {
    return await startConnectorOAuthAuthorization(definition.service, connectionName, actionIds);
  } catch (error) {
    await getPool().query(`
      UPDATE employee_connector_bindings
      SET status = 'error', error_message = $3, updated_at = NOW()
      WHERE principal_issuer = $1 AND principal_subject = $2 AND service = $4
    `, [
      identity.principalIssuer,
      identity.principalSubject,
      error instanceof Error ? error.message : "无法开始 OAuth 授权",
      definition.service,
    ]);
    throw error;
  }
}

export async function disconnectEmployeeIntegration(identity: ConsoleIdentity, applicationId: string) {
  await ensureSchema();
  const safeApplicationId = requiredUuid(applicationId);
  const result = await getPool().query<EmployeeConnectorBindingRow>(`
    SELECT id, application_id, platform, service, connection_name, status,
           display_name, account_id, error_message, connected_at, updated_at
    FROM employee_connector_bindings
    WHERE principal_issuer = $1 AND principal_subject = $2
      AND application_id = $3 AND status <> 'revoked'
  `, [identity.principalIssuer, identity.principalSubject, safeApplicationId]);
  const binding = result.rows[0];
  if (!binding) throw new IntegrationStoreError("个人账号尚未绑定", 404);
  await deleteConnectorConnection(binding.service, binding.connection_name);
  await getPool().query(`
    UPDATE employee_connector_bindings
    SET status = 'revoked', error_message = NULL, updated_at = NOW()
    WHERE id = $1
  `, [binding.id]);
  return { disconnected: true };
}

export async function resolveEmployeeConnectorBindings(input: {
  issuer: string;
  subject: string;
  email?: string;
  service?: string;
}) {
  await ensureSchema();
  const issuer = requiredValue(input.issuer, "Issuer", 2_048);
  const subject = requiredValue(input.subject, "Subject", 512);
  const email = input.email?.trim().toLowerCase()
    ? requiredValue(input.email.trim().toLowerCase(), "Email", 320)
    : undefined;
  const service = input.service ? requiredValue(input.service, "Service", 128) : undefined;
  let result = await getPool().query<EmployeeConnectorBindingRow>(`
    SELECT id, application_id, platform, service, connection_name, status,
           display_name, account_id, error_message, connected_at, updated_at
    FROM employee_connector_bindings
    WHERE principal_issuer = $1 AND principal_subject = $2 AND status = 'connected'
      AND ($3::TEXT IS NULL OR service = $3)
    ORDER BY service
  `, [issuer, subject, service || null]);

  // Pomerium and the MCP OAuth broker may expose different opaque subjects for
  // the same upstream employee. The email fallback is accepted only because it
  // comes from the broker-verified access token over the authenticated internal
  // resolver channel. Ambiguous matches fail closed.
  if (!result.rowCount && email) {
    result = await getPool().query<EmployeeConnectorBindingRow>(`
      SELECT id, application_id, platform, service, connection_name, status,
             display_name, account_id, error_message, connected_at, updated_at
      FROM employee_connector_bindings
      WHERE principal_issuer = $1 AND LOWER(principal_email) = $2 AND status = 'connected'
        AND ($3::TEXT IS NULL OR service = $3)
      ORDER BY service
    `, [issuer, email, service || null]);
    const services = new Set<string>();
    for (const row of result.rows) {
      if (services.has(row.service)) {
        throw new IntegrationStoreError("员工账号存在冲突的 Connector 绑定", 409);
      }
      services.add(row.service);
    }
  }

  const snapshot = await listConnectorConnections();
  const valid = new Map(
    snapshot.connections
      .filter((connection) => connection.configured)
      .map((connection) => [`${connection.service}\0${connection.connectionName}`, connection]),
  );
  const boundConnections = result.rows.flatMap((row) => {
    const current = valid.get(`${row.service}\0${row.connection_name}`);
    return current ? [{
      service: row.service,
      connectionName: row.connection_name,
      displayName: current.profile.displayName,
      public: false,
    }] : [];
  });
  const boundServices = new Set(boundConnections.map((connection) => connection.service));
  const publicConnections = snapshot.connections
    .filter((connection) => (
      connection.configured
      && connection.virtual
      && connection.authType === "no_auth"
      && !boundServices.has(connection.service)
    ))
    .map((connection) => ({
      service: connection.service,
      connectionName: "default",
      displayName: connection.profile.displayName,
      public: true,
    }));
  const connections = [...boundConnections, ...publicConnections];

  if (service && !connections[0]) {
    const publicConnection = publicConnections.find((connection) => connection.service === service);
    if (publicConnection) return publicConnection;
    throw new IntegrationStoreError("当前员工没有可用的个人 Connector", 404);
  }
  if (service) {
    const connection = connections.find((item) => item.service === service);
    if (!connection) throw new IntegrationStoreError("当前员工没有可用的个人 Connector", 404);
    return connection;
  }
  return { connections };
}

function requiredUuid(value: string) {
  if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(value)) {
    throw new IntegrationStoreError("无效的应用配置 ID", 400);
  }
  return value;
}

function isUniqueViolation(error: unknown) {
  return Boolean(error && typeof error === "object" && "code" in error && error.code === "23505");
}

function isForeignKeyViolation(error: unknown) {
  return Boolean(error && typeof error === "object" && "code" in error && error.code === "23503");
}
