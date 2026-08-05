import type { QueryResultRow } from "pg";

import type {
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

const CORP_ID_MAX_LENGTH = 255;
const APP_SECRET_MAX_LENGTH = 4_096;
const MAX_URL_LENGTH = 2_048;
const MAX_EMAIL_DOMAIN_LENGTH = 253;

type JsonObject = Record<string, unknown>;

type WeComAuthenticationRow = QueryResultRow & {
  corp_id: string;
  app_secret_ciphertext: string | null;
  public_base_url: string;
  callback_mode: "direct" | "relay";
  relay_callback_url: string | null;
  email_domain: string;
  updated_at: Date | string;
};

export type WeComAuthenticationValidationResult =
  | { ok: true; value: WeComAuthenticationSettings }
  | { ok: false; errors: string[] };

function isObject(value: unknown): value is JsonObject {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function unknownKeys(value: JsonObject, allowed: readonly string[]) {
  const allowedKeys = new Set(allowed);
  return Object.keys(value).filter((key) => !allowedKeys.has(key));
}

function normalizeHttpUrl(value: unknown, field: string, errors: string[]) {
  const label = field === "publicBaseUrl" ? "AI Base 公开认证入口" : "公网中继回调地址";
  if (typeof value !== "string" || value.length === 0 || value.length > MAX_URL_LENGTH) {
    errors.push(`${label}必须是非空 URL，且不超过 ${MAX_URL_LENGTH} 个字符`);
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
    ) {
      throw new Error("unsupported URL");
    }
    return parsed.toString().replace(/\/$/, "");
  } catch {
    errors.push(`${label}必须是绝对 HTTP(S) 地址，且不能包含账号、查询参数或片段`);
    return undefined;
  }
}

function normalizeEmailDomain(value: unknown, errors: string[]) {
  if (typeof value !== "string") {
    errors.push("企业邮箱域必须是 DNS 域名");
    return undefined;
  }
  const normalized = value.trim().toLowerCase();
  if (
    normalized.length === 0
    || normalized.length > MAX_EMAIL_DOMAIN_LENGTH
    || !/^(?=.{1,253}$)(?:[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/.test(normalized)
  ) {
    errors.push("企业邮箱域必须是有效的 DNS 域名");
    return undefined;
  }
  return normalized;
}

export function validateWeComAuthenticationSettings(
  input: unknown,
): WeComAuthenticationValidationResult {
  if (!isObject(input)) {
    return { ok: false, errors: ["request body must be a JSON object"] };
  }
  const errors = unknownKeys(input, [
    "corpId",
    "appSecret",
    "publicBaseUrl",
    "callbackMode",
    "relayCallbackUrl",
    "emailDomain",
  ]).map((key) => `unsupported field: ${key}`);
  const corpId = typeof input.corpId === "string" ? input.corpId.trim() : "";
  if (!corpId) errors.push("企业 ID（CorpID）不能为空");
  else if (corpId.length > CORP_ID_MAX_LENGTH) errors.push(`企业 ID（CorpID）长度不能超过 ${CORP_ID_MAX_LENGTH} 个字符`);
  let appSecret: string | undefined;
  if (input.appSecret !== undefined && input.appSecret !== "") {
    if (typeof input.appSecret !== "string" || !input.appSecret.trim()) {
      errors.push("App Secret 不能为空");
    } else if (input.appSecret.length > APP_SECRET_MAX_LENGTH) {
      errors.push(`App Secret 长度不能超过 ${APP_SECRET_MAX_LENGTH} 个字符`);
    } else {
      appSecret = input.appSecret;
    }
  }
  const publicBaseUrl = normalizeHttpUrl(input.publicBaseUrl, "publicBaseUrl", errors);
  const callbackMode = input.callbackMode;
  if (callbackMode !== "direct" && callbackMode !== "relay") {
    errors.push("回调方式必须是直接回调或公网中继");
  }
  let relayCallbackUrl: string | undefined;
  if (callbackMode === "relay") {
    relayCallbackUrl = normalizeHttpUrl(input.relayCallbackUrl, "relayCallbackUrl", errors);
  } else if (
    input.relayCallbackUrl !== undefined
    && (typeof input.relayCallbackUrl !== "string" || input.relayCallbackUrl.length > MAX_URL_LENGTH)
  ) {
    errors.push(`公网中继回调地址不能超过 ${MAX_URL_LENGTH} 个字符`);
  }
  const emailDomain = normalizeEmailDomain(input.emailDomain, errors);
  if (
    errors.length
    || !corpId
    || !publicBaseUrl
    || !emailDomain
    || (callbackMode !== "direct" && callbackMode !== "relay")
  ) {
    return { ok: false, errors };
  }
  return {
    ok: true,
    value: {
      corpId,
      ...(appSecret ? { appSecret } : {}),
      publicBaseUrl,
      callbackMode,
      ...(callbackMode === "relay" && relayCallbackUrl ? { relayCallbackUrl } : {}),
      emailDomain,
    },
  };
}

export function resolveWeComCallbackUrl(settings: Pick<
  WeComAuthenticationSettings,
  "callbackMode" | "relayCallbackUrl" | "publicBaseUrl"
>) {
  return settings.callbackMode === "relay" && settings.relayCallbackUrl
    ? settings.relayCallbackUrl
    : `${settings.publicBaseUrl}/callback`;
}

function serializeSnapshot(row: WeComAuthenticationRow): WeComAuthenticationSnapshot {
  const runtime = {
    publicBaseUrl: row.public_base_url,
    callbackMode: row.callback_mode,
    ...(row.relay_callback_url ? { relayCallbackUrl: row.relay_callback_url } : {}),
    emailDomain: row.email_domain,
  };
  const secretConfigured = Boolean(row.app_secret_ciphertext);
  return {
    corpId: row.corp_id,
    ...runtime,
    configured: Boolean(row.corp_id && secretConfigured),
    secretConfigured,
    effectiveCallbackUrl: resolveWeComCallbackUrl(runtime),
    updatedAt: new Date(row.updated_at).toISOString(),
  };
}

async function readRow() {
  await ensureSchema();
  const result = await getPool().query<WeComAuthenticationRow>(`
    SELECT corp_id, app_secret_ciphertext, public_base_url, callback_mode,
           relay_callback_url, email_domain, updated_at
    FROM wecom_authentication_configuration
    WHERE singleton_key = 'default'
  `);
  const row = result.rows[0];
  if (!row) throw new IntegrationStoreError("企业微信认证配置不存在", 503);
  return row;
}

export async function getWeComAuthenticationConfiguration() {
  return serializeSnapshot(await readRow());
}

export async function updateWeComAuthenticationConfiguration(
  settings: WeComAuthenticationSettings,
) {
  const current = await readRow();
  if (!settings.appSecret && !current.app_secret_ciphertext) {
    throw new IntegrationStoreError("首次保存企业微信认证配置时必须填写 App Secret", 400);
  }
  const replacementSecret = settings.appSecret
    ? encryptIntegrationSecret(settings.appSecret)
    : null;
  const result = await getPool().query<WeComAuthenticationRow>(`
    UPDATE wecom_authentication_configuration
    SET corp_id = $1,
        app_secret_ciphertext = COALESCE($2, app_secret_ciphertext),
        public_base_url = $3,
        callback_mode = $4,
        relay_callback_url = $5,
        email_domain = $6,
        updated_at = NOW()
    WHERE singleton_key = 'default'
    RETURNING corp_id, app_secret_ciphertext, public_base_url, callback_mode,
              relay_callback_url, email_domain, updated_at
  `, [
    settings.corpId,
    replacementSecret,
    settings.publicBaseUrl,
    settings.callbackMode,
    settings.callbackMode === "relay" ? settings.relayCallbackUrl || null : null,
    settings.emailDomain,
  ]);
  resetWeComVisibilityCache();
  return serializeSnapshot(result.rows[0]);
}

export async function getWeComAuthenticationCredential() {
  const row = await readRow();
  if (!row.corp_id || !row.app_secret_ciphertext) {
    throw new IntegrationStoreError("企业微信认证尚未完成配置", 404);
  }
  return {
    id: "wecom-authentication",
    name: "企业微信认证",
    corpId: row.corp_id,
    appSecret: decryptIntegrationSecret(row.app_secret_ciphertext),
    updatedAt: new Date(row.updated_at).toISOString(),
  };
}
