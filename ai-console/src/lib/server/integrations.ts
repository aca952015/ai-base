import { createCipheriv, createHash, randomBytes, randomUUID } from "node:crypto";

import { Pool, type QueryResultRow } from "pg";

import type {
  EnterpriseIntegrationGroup,
  EnterpriseIntegrationPlatform,
  EnterpriseIntegrationsSnapshot,
  IntegrationApplication,
} from "../control-plane/integrations";

const APP_ID_MAX_LENGTH = 255;
const APP_NAME_MAX_LENGTH = 120;
const APP_NOTE_MAX_LENGTH = 500;
const APP_SECRET_MAX_LENGTH = 4_096;
const ENCRYPTION_VERSION = "v1";

const platformDefinitions: Array<Omit<EnterpriseIntegrationGroup, "applications">> = [
  {
    platform: "feishu",
    displayName: "飞书",
    description: "管理飞书开放平台应用凭据。",
  },
  {
    platform: "wecom",
    displayName: "企微",
    description: "管理企微自建应用凭据。",
  },
  {
    platform: "dingtalk",
    displayName: "钉钉",
    description: "管理钉钉开放平台应用凭据。",
  },
];

const allowedPlatforms = new Set(platformDefinitions.map((definition) => definition.platform));

type IntegrationApplicationRow = QueryResultRow & {
  id: string;
  platform: EnterpriseIntegrationPlatform;
  app_name: string;
  app_id: string;
  note: string;
  created_at: Date | string;
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
      ALTER TABLE integration_applications ALTER COLUMN note SET NOT NULL
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

function serializeApplication(row: IntegrationApplicationRow): IntegrationApplication {
  return {
    id: row.id,
    platform: row.platform,
    name: row.app_name,
    appId: row.app_id,
    note: row.note,
    secretConfigured: true,
    createdAt: new Date(row.created_at).toISOString(),
    updatedAt: new Date(row.updated_at).toISOString(),
  };
}

export function buildEnterpriseIntegrationsSnapshot(
  applications: IntegrationApplication[],
  updatedAt = new Date().toISOString(),
): EnterpriseIntegrationsSnapshot {
  return {
    groups: platformDefinitions.map((definition) => ({
      ...definition,
      applications: applications.filter((application) => application.platform === definition.platform),
    })),
    updatedAt,
  };
}

export async function getEnterpriseIntegrations(): Promise<EnterpriseIntegrationsSnapshot> {
  await ensureSchema();
  const result = await getPool().query<IntegrationApplicationRow>(`
    SELECT id, platform, app_name, app_id, note, created_at, updated_at
    FROM integration_applications
    ORDER BY platform, created_at, app_name, app_id
  `);
  return buildEnterpriseIntegrationsSnapshot(result.rows.map(serializeApplication));
}

export async function createIntegrationApplication(input: {
  platform: unknown;
  name: unknown;
  appId: unknown;
  note?: unknown;
  appSecret: unknown;
}) {
  await ensureSchema();
  const platform = normalizePlatform(input.platform);
  const name = requiredValue(input.name, "应用名称", APP_NAME_MAX_LENGTH);
  const appId = requiredValue(input.appId, "App ID", APP_ID_MAX_LENGTH);
  const note = optionalValue(input.note, "备注", APP_NOTE_MAX_LENGTH);
  const appSecret = requiredSecret(input.appSecret);
  try {
    const result = await getPool().query<IntegrationApplicationRow>(`
      INSERT INTO integration_applications (id, platform, app_name, app_id, note, app_secret_ciphertext)
      VALUES ($1, $2, $3, $4, $5, $6)
      RETURNING id, platform, app_name, app_id, note, created_at, updated_at
    `, [randomUUID(), platform, name, appId, note, encryptIntegrationSecret(appSecret)]);
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
}) {
  await ensureSchema();
  const safeId = requiredUuid(id);
  const name = requiredValue(input.name, "应用名称", APP_NAME_MAX_LENGTH);
  const appId = requiredValue(input.appId, "App ID", APP_ID_MAX_LENGTH);
  const note = optionalValue(input.note, "备注", APP_NOTE_MAX_LENGTH);
  const appSecret = optionalSecret(input.appSecret);
  const parameters = appSecret
    ? [safeId, name, appId, note, encryptIntegrationSecret(appSecret)]
    : [safeId, name, appId, note];
  const secretAssignment = appSecret ? ", app_secret_ciphertext = $5" : "";
  try {
    const result = await getPool().query<IntegrationApplicationRow>(`
      UPDATE integration_applications
      SET app_name = $2, app_id = $3, note = $4${secretAssignment}, updated_at = NOW()
      WHERE id = $1
      RETURNING id, platform, app_name, app_id, note, created_at, updated_at
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
  const result = await getPool().query(
    "DELETE FROM integration_applications WHERE id = $1",
    [requiredUuid(id)],
  );
  if (!result.rowCount) throw new IntegrationStoreError("应用配置不存在", 404);
  return { deleted: true };
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
