import { randomUUID } from "node:crypto";

import type { QueryResultRow } from "pg";

import type {
  WeComAuthenticationOrganizationSnapshot,
  WeComAuthenticationSettings,
  WeComAuthenticationSnapshot,
} from "../control-plane/types";
import {
  ensureSchema,
  getPool,
  IntegrationStoreError,
  resetWeComVisibilityCache,
} from "./integrations";
import { wecomRelayApplicationHomepageUrl } from "./wecom-identity-link-routing";

const ORGANIZATION_NAME_MAX_LENGTH = 120;
const CORP_ID_MAX_LENGTH = 255;
const MAX_URL_LENGTH = 2_048;
// PostgreSQL's UUID type accepts canonical UUID text without enforcing RFC
// version or variant bits. The migrated default organization intentionally uses
// a stable reserved UUID, so request validation must follow the same contract.
const UUID_PATTERN = /^[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}$/i;

type JsonObject = Record<string, unknown>;

function duplicateOrganizationMessage(error: object) {
  return "constraint" in error
    && error.constraint === "wecom_authentication_organizations_relay_callback_url_idx"
    ? "该公网认证中继已映射到其他组织"
    : "该 CorpID 已存在";
}

type WeComAuthenticationRow = QueryResultRow & {
  id: string;
  organization_name: string;
  corp_id: string;
  relay_callback_url: string | null;
  active: boolean;
  updated_at: Date | string;
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
      parsed.protocol !== "https:"
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
    errors.push("公网认证中继回调地址必须是以 /callbacks/wecom 结尾的绝对 HTTPS 地址，且不能包含账号、查询参数或片段");
    return undefined;
  }
}

export function validateWeComAuthenticationSettings(
  input: unknown,
): WeComAuthenticationValidationResult {
  if (!isObject(input)) return { ok: false, errors: ["request body must be a JSON object"] };
  const allowed = new Set(["id", "organizationName", "corpId", "relayCallbackUrl", "active"]);
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
      relayCallbackUrl,
      active,
    },
  };
}

function serializeOrganization(row: WeComAuthenticationRow): WeComAuthenticationOrganizationSnapshot {
  const relayCallbackUrl = row.relay_callback_url || "";
  return {
    id: row.id,
    organizationName: row.organization_name,
    corpId: row.corp_id,
    relayCallbackUrl,
    active: row.active,
    configured: Boolean(row.active && row.corp_id && relayCallbackUrl),
    applicationHomepageUrl: relayCallbackUrl
      ? wecomRelayApplicationHomepageUrl(relayCallbackUrl).toString()
      : "",
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
    SELECT id, organization_name, corp_id, relay_callback_url, active, updated_at
    FROM wecom_authentication_organizations
    ORDER BY organization_name, created_at, id
  `)).rows;
}

async function readRow(id: string) {
  if (!UUID_PATTERN.test(id)) throw new IntegrationStoreError("企业微信组织 ID 无效", 400);
  await ensureSchema();
  const row = (await getPool().query<WeComAuthenticationRow>(`
    SELECT id, organization_name, corp_id, relay_callback_url, active, updated_at
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
  await ensureSchema();
  try {
    const row = (await getPool().query<WeComAuthenticationRow>(`
      INSERT INTO wecom_authentication_organizations (
        id, organization_name, corp_id, relay_callback_url, active
      ) VALUES ($1, $2, $3, $4, $5)
      RETURNING id, organization_name, corp_id, relay_callback_url, active, updated_at
    `, [
      randomUUID(), settings.organizationName, settings.corpId,
      settings.relayCallbackUrl, settings.active,
    ])).rows[0];
    resetWeComVisibilityCache();
    return serializeOrganization(row);
  } catch (error) {
    if (error && typeof error === "object" && "code" in error && error.code === "23505") {
      throw new IntegrationStoreError(duplicateOrganizationMessage(error), 409);
    }
    throw error;
  }
}

export async function updateWeComAuthenticationConfiguration(settings: WeComAuthenticationSettings) {
  if (!settings.id) throw new IntegrationStoreError("企业微信组织 ID 不能为空", 400);
  await readRow(settings.id);
  try {
    const row = (await getPool().query<WeComAuthenticationRow>(`
      UPDATE wecom_authentication_organizations
      SET organization_name = $2, corp_id = $3,
          relay_callback_url = $4, active = $5, updated_at = NOW()
      WHERE id = $1
      RETURNING id, organization_name, corp_id, relay_callback_url, active, updated_at
    `, [
      settings.id, settings.organizationName, settings.corpId,
      settings.relayCallbackUrl, settings.active,
    ])).rows[0];
    resetWeComVisibilityCache();
    return serializeOrganization(row);
  } catch (error) {
    if (error && typeof error === "object" && "code" in error && error.code === "23505") {
      throw new IntegrationStoreError(duplicateOrganizationMessage(error), 409);
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

export async function getWeComOrganizationIdForRelay(relayCallbackUrl: string): Promise<string> {
  await ensureSchema();
  const candidates = (await getPool().query<WeComAuthenticationRow>(`
    SELECT id, organization_name, corp_id, relay_callback_url, active, updated_at
    FROM wecom_authentication_organizations
    WHERE relay_callback_url = $1
      AND active
      AND corp_id <> ''
  `, [relayCallbackUrl])).rows;
  if (candidates.length !== 1) {
    throw new IntegrationStoreError("企业微信中继未映射到唯一的认证组织", 404);
  }
  return candidates[0].id;
}
