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

type JsonObject = Record<string, unknown>;

type WeComAuthenticationRow = QueryResultRow & {
  corp_id: string;
  app_secret_ciphertext: string | null;
  relay_callback_url: string | null;
  updated_at: Date | string;
};

export type WeComRelayCredential = {
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
  if (!isObject(input)) {
    return { ok: false, errors: ["request body must be a JSON object"] };
  }
  const allowed = new Set(["corpId", "appSecret", "relayCallbackUrl"]);
  const errors = Object.keys(input)
    .filter((key) => !allowed.has(key))
    .map((key) => `unsupported field: ${key}`);
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
  const relayCallbackUrl = normalizeRelayCallbackUrl(input.relayCallbackUrl, errors);
  if (errors.length || !corpId || !relayCallbackUrl) {
    return { ok: false, errors };
  }
  return {
    ok: true,
    value: {
      corpId,
      ...(appSecret ? { appSecret } : {}),
      relayCallbackUrl,
    },
  };
}

export function resolveWeComCallbackUrl(settings: Pick<WeComAuthenticationSettings, "relayCallbackUrl">) {
  return settings.relayCallbackUrl;
}

function serializeSnapshot(row: WeComAuthenticationRow): WeComAuthenticationSnapshot {
  const relayCallbackUrl = row.relay_callback_url || "";
  const secretConfigured = Boolean(row.app_secret_ciphertext);
  return {
    corpId: row.corp_id,
    relayCallbackUrl,
    configured: Boolean(row.corp_id && secretConfigured && relayCallbackUrl),
    secretConfigured,
    effectiveCallbackUrl: relayCallbackUrl,
    updatedAt: new Date(row.updated_at).toISOString(),
  };
}

async function readRow() {
  await ensureSchema();
  const result = await getPool().query<WeComAuthenticationRow>(`
    SELECT corp_id, app_secret_ciphertext, relay_callback_url, updated_at
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
        callback_mode = 'relay',
        relay_callback_url = $3,
        updated_at = NOW()
    WHERE singleton_key = 'default'
    RETURNING corp_id, app_secret_ciphertext, relay_callback_url, updated_at
  `, [settings.corpId, replacementSecret, settings.relayCallbackUrl]);
  resetWeComVisibilityCache();
  return serializeSnapshot(result.rows[0]);
}

export async function getWeComRelayCredential(): Promise<WeComRelayCredential> {
  const row = await readRow();
  if (!row.corp_id || !row.app_secret_ciphertext || !row.relay_callback_url) {
    throw new IntegrationStoreError("企业微信中继认证尚未完成配置", 404);
  }
  return {
    corpId: row.corp_id,
    appSecret: decryptIntegrationSecret(row.app_secret_ciphertext),
    relayCallbackUrl: row.relay_callback_url,
  };
}
