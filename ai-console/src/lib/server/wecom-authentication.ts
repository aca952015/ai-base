import { createHash, randomUUID } from "node:crypto";

import type { QueryResultRow } from "pg";

import type {
  WeComAuthenticationOrganizationSnapshot,
  WeComAuthenticationSettings,
  WeComAuthenticationSnapshot,
} from "../control-plane/types";
import {
  decryptIntegrationSecret,
  encryptIntegrationSecret,
  ensureSchema,
  getPool,
  IntegrationStoreError,
  resetWeComVisibilityCache,
} from "./integrations";
import { wecomIdentityStartUrl } from "./wecom-identity-link-routing";

const ORGANIZATION_NAME_MAX_LENGTH = 120;
const CORP_ID_MAX_LENGTH = 255;
const APP_SECRET_MAX_LENGTH = 4_096;
const MAX_URL_LENGTH = 2_048;
const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

type JsonObject = Record<string, unknown>;

type WeComAuthenticationRow = QueryResultRow & {
  id: string;
  organization_name: string;
  corp_id: string;
  app_secret_ciphertext: string | null;
  relay_callback_url: string | null;
  active: boolean;
  updated_at: Date | string;
};

export type WeComRelayCredential = {
  organizationId: string;
  organizationName: string;
  corpId: string;
  appSecret: string;
  relayCallbackUrl: string;
};

export type WeComAuthenticationValidationResult =
  | { ok: true; value: WeComAuthenticationSettings }
  | { ok: false; errors: string[] };

function isObject(value: unknown): value is JsonObject {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function normalizeRelayCallbackUrl(value: unknown, errors: string[]) {
  if (typeof value !== "string" || value.length === 0 || value.length > MAX_URL_LENGTH) {
    errors.push(`公网认证中继回调地址必须是非空 URL，且不超过 ${MAX_URL_LENGTH} 个字符`);
    return undefined;
  }
  try {
    const parsed = new URL(value);
    if (
      !["http:", "https:"].includes(parsed.protocol)
      || parsed.username
      || parsed.password
      || parsed.search
      || parsed.hash
      || parsed.pathname !== "/callbacks/wecom"
    ) {
      throw new Error("unsupported URL");
    }
    return parsed.toString();
  } catch {
    errors.push("公网认证中继回调地址必须是以 /callbacks/wecom 结尾的绝对 HTTP(S) 地址，且不能包含账号、查询参数或片段");
    return undefined;
  }
}

export function validateWeComAuthenticationSettings(
  input: unknown,
): WeComAuthenticationValidationResult {
  if (!isObject(input)) return { ok: false, errors: ["request body must be a JSON object"] };
  const allowed = new Set(["id", "organizationName", "corpId", "appSecret", "relayCallbackUrl", "active"]);
  const errors = Object.keys(input)
    .filter((key) => !allowed.has(key))
    .map((key) => `unsupported field: ${key}`);
  const id = typeof input.id === "string" ? input.id.trim() : undefined;
  if (id && !UUID_PATTERN.test(id)) errors.push("企业微信组织 ID 无效");
  const organizationName = typeof input.organizationName === "string" ? input.organizationName.trim() : "";
  if (!organizationName) errors.push("组织名称不能为空");
  else if (organizationName.length > ORGANIZATION_NAME_MAX_LENGTH) {
    errors.push(`组织名称长度不能超过 ${ORGANIZATION_NAME_MAX_LENGTH} 个字符`);
  }
  const corpId = typeof input.corpId === "string" ? input.corpId.trim() : "";
  if (!corpId) errors.push("企业 ID（CorpID）不能为空");
  else if (corpId.length > CORP_ID_MAX_LENGTH) errors.push(`企业 ID（CorpID）长度不能超过 ${CORP_ID_MAX_LENGTH} 个字符`);
  let appSecret: string | undefined;
  if (input.appSecret !== undefined && input.appSecret !== "") {
    if (typeof input.appSecret !== "string" || !input.appSecret.trim()) errors.push("App Secret 不能为空");
    else if (input.appSecret.length > APP_SECRET_MAX_LENGTH) errors.push(`App Secret 长度不能超过 ${APP_SECRET_MAX_LENGTH} 个字符`);
    else appSecret = input.appSecret;
  }
  const relayCallbackUrl = normalizeRelayCallbackUrl(input.relayCallbackUrl, errors);
  const active = input.active === undefined ? true : input.active;
  if (typeof active !== "boolean") errors.push("启用状态格式无效");
  if (errors.length || !organizationName || !corpId || !relayCallbackUrl || typeof active !== "boolean") {
    return { ok: false, errors };
  }
  return {
    ok: true,
    value: {
      ...(id ? { id } : {}),
      organizationName,
      corpId,
      ...(appSecret ? { appSecret } : {}),
      relayCallbackUrl,
      active,
    },
  };
}

export function resolveWeComCallbackUrl(settings: Pick<WeComAuthenticationSettings, "relayCallbackUrl">) {
  return settings.relayCallbackUrl;
}

function serializeOrganization(row: WeComAuthenticationRow): WeComAuthenticationOrganizationSnapshot {
  const relayCallbackUrl = row.relay_callback_url || "";
  const secretConfigured = Boolean(row.app_secret_ciphertext);
  return {
    id: row.id,
    organizationName: row.organization_name,
    corpId: row.corp_id,
    relayCallbackUrl,
    active: row.active,
    configured: Boolean(row.active && row.corp_id && secretConfigured && relayCallbackUrl),
    secretConfigured,
    effectiveCallbackUrl: relayCallbackUrl,
    applicationHomepageUrl: wecomIdentityStartUrl(row.id).toString(),
    updatedAt: new Date(row.updated_at).toISOString(),
  };
}

function serializeSnapshot(rows: WeComAuthenticationRow[]): WeComAuthenticationSnapshot {
  const organizations = rows.map(serializeOrganization);
  return {
    organizations,
    configuredCount: organizations.filter((organization) => organization.configured).length,
    updatedAt: organizations.reduce((value, organization) => (
      organization.updatedAt > value ? organization.updatedAt : value
    ), new Date(0).toISOString()),
  };
}

async function readRows() {
  await ensureSchema();
  return (await getPool().query<WeComAuthenticationRow>(`
    SELECT id, organization_name, corp_id, app_secret_ciphertext,
           relay_callback_url, active, updated_at
    FROM wecom_authentication_organizations
    ORDER BY organization_name, created_at, id
  `)).rows;
}

async function readRow(id: string) {
  if (!UUID_PATTERN.test(id)) throw new IntegrationStoreError("企业微信组织 ID 无效", 400);
  await ensureSchema();
  const row = (await getPool().query<WeComAuthenticationRow>(`
    SELECT id, organization_name, corp_id, app_secret_ciphertext,
           relay_callback_url, active, updated_at
    FROM wecom_authentication_organizations
    WHERE id = $1
  `, [id])).rows[0];
  if (!row) throw new IntegrationStoreError("企业微信认证组织不存在", 404);
  return row;
}

export async function getWeComAuthenticationConfiguration() {
  return serializeSnapshot(await readRows());
}

export async function createWeComAuthenticationConfiguration(settings: WeComAuthenticationSettings) {
  if (!settings.appSecret) throw new IntegrationStoreError("新增企业微信认证组织时必须填写 App Secret", 400);
  await ensureSchema();
  try {
    const row = (await getPool().query<WeComAuthenticationRow>(`
      INSERT INTO wecom_authentication_organizations (
        id, organization_name, corp_id, app_secret_ciphertext, relay_callback_url, active
      ) VALUES ($1, $2, $3, $4, $5, $6)
      RETURNING id, organization_name, corp_id, app_secret_ciphertext,
                relay_callback_url, active, updated_at
    `, [
      randomUUID(), settings.organizationName, settings.corpId,
      encryptIntegrationSecret(settings.appSecret), settings.relayCallbackUrl, settings.active,
    ])).rows[0];
    resetWeComVisibilityCache();
    return serializeOrganization(row);
  } catch (error) {
    if (error && typeof error === "object" && "code" in error && error.code === "23505") {
      throw new IntegrationStoreError("该 CorpID 已存在", 409);
    }
    throw error;
  }
}

export async function updateWeComAuthenticationConfiguration(settings: WeComAuthenticationSettings) {
  if (!settings.id) throw new IntegrationStoreError("企业微信组织 ID 不能为空", 400);
  const current = await readRow(settings.id);
  if (!settings.appSecret && !current.app_secret_ciphertext) {
    throw new IntegrationStoreError("首次保存企业微信认证配置时必须填写 App Secret", 400);
  }
  const replacementSecret = settings.appSecret ? encryptIntegrationSecret(settings.appSecret) : null;
  try {
    const row = (await getPool().query<WeComAuthenticationRow>(`
      UPDATE wecom_authentication_organizations
      SET organization_name = $2, corp_id = $3,
          app_secret_ciphertext = COALESCE($4, app_secret_ciphertext),
          relay_callback_url = $5, active = $6, updated_at = NOW()
      WHERE id = $1
      RETURNING id, organization_name, corp_id, app_secret_ciphertext,
                relay_callback_url, active, updated_at
    `, [
      settings.id, settings.organizationName, settings.corpId,
      replacementSecret, settings.relayCallbackUrl, settings.active,
    ])).rows[0];
    resetWeComVisibilityCache();
    return serializeOrganization(row);
  } catch (error) {
    if (error && typeof error === "object" && "code" in error && error.code === "23505") {
      throw new IntegrationStoreError("该 CorpID 已存在", 409);
    }
    throw error;
  }
}

export async function deleteWeComAuthenticationConfiguration(id: string) {
  if (!UUID_PATTERN.test(id)) throw new IntegrationStoreError("企业微信组织 ID 无效", 400);
  await ensureSchema();
  try {
    const client = await getPool().connect();
    let result;
    try {
      await client.query("BEGIN");
      await client.query(`
        DELETE FROM wecom_identity_login_requests
        WHERE organization_id = $1 AND (consumed_at IS NOT NULL OR expires_at <= NOW())
      `, [id]);
      result = await client.query(
        "DELETE FROM wecom_authentication_organizations WHERE id = $1 RETURNING id",
        [id],
      );
      await client.query("COMMIT");
    } catch (error) {
      await client.query("ROLLBACK");
      throw error;
    } finally {
      client.release();
    }
    if (!result.rowCount) throw new IntegrationStoreError("企业微信认证组织不存在", 404);
    resetWeComVisibilityCache();
    return { deleted: true as const };
  } catch (error) {
    if (error && typeof error === "object" && "code" in error && error.code === "23503") {
      throw new IntegrationStoreError("该组织仍有关联身份、登录请求或共享连接，不能删除；可先停用", 409);
    }
    throw error;
  }
}

function credentialFromRow(row: WeComAuthenticationRow): WeComRelayCredential {
  if (!row.active || !row.corp_id || !row.app_secret_ciphertext || !row.relay_callback_url) {
    throw new IntegrationStoreError("企业微信中继认证尚未完成配置或已停用", 404);
  }
  return {
    organizationId: row.id,
    organizationName: row.organization_name,
    corpId: row.corp_id,
    appSecret: decryptIntegrationSecret(row.app_secret_ciphertext),
    relayCallbackUrl: row.relay_callback_url,
  };
}

export async function getWeComRelayCredential(organizationId?: string): Promise<WeComRelayCredential> {
  if (organizationId) return credentialFromRow(await readRow(organizationId));
  const candidates = (await readRows()).filter((row) => (
    row.active && row.corp_id && row.app_secret_ciphertext && row.relay_callback_url
  ));
  if (candidates.length === 1) return credentialFromRow(candidates[0]);
  if (!candidates.length) throw new IntegrationStoreError("企业微信中继认证尚未完成配置", 404);
  throw new IntegrationStoreError("存在多个企业微信组织，请从对应组织的应用首页进入", 400);
}

export async function getWeComRelayCredentialForLoginRequest(requestToken: string) {
  if (!/^[A-Za-z0-9_-]{43}$/.test(requestToken)) {
    throw new IntegrationStoreError("企微自动登录请求无效", 400, "invalid_wecom_link_request");
  }
  await ensureSchema();
  const requestHash = createHash("sha256").update(requestToken, "utf8").digest("hex");
  const row = (await getPool().query<WeComAuthenticationRow>(`
    SELECT organization.id, organization.organization_name, organization.corp_id,
           organization.app_secret_ciphertext, organization.relay_callback_url,
           organization.active, organization.updated_at
    FROM wecom_identity_login_requests AS login_request
    JOIN wecom_authentication_organizations AS organization
      ON organization.id = login_request.organization_id
    WHERE login_request.request_hash = $1
      AND login_request.consumed_at IS NULL
      AND login_request.expires_at > NOW()
  `, [requestHash])).rows[0];
  if (!row) throw new IntegrationStoreError("企微自动登录请求已失效", 410, "expired_wecom_link_request");
  return credentialFromRow(row);
}
