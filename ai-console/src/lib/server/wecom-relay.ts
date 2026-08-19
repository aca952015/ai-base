import {
  createCipheriv,
  createDecipheriv,
  randomBytes,
} from "node:crypto";

import type { WeComRelayCredential } from "./wecom-authentication";
import { wecomIdentityLinkCompletionUrl } from "./wecom-identity-link-routing";

const TICKET_VERSION = 1;
const TICKET_AAD = Buffer.from("ai-base-wecom-relay:v1", "utf8");
const TICKET_MAX_LENGTH = 16 << 10;
const AUTHORIZATION_TICKET_LIFETIME_MS = 10 * 60_000;
const RESULT_LIFETIME_SECONDS = 5 * 60;
const SECRET_PATTERN = /^[A-Za-z0-9_-]{43}$/;
const USER_ID_MAX_LENGTH = 256;

type RelayResultPayload = {
  v: number;
  authorization_id: string;
  request_token: string;
  corp_id?: string;
  user_id?: string;
  error?: string;
  issued_at: number;
  expires_at: number;
};

export type WeComRelayIdentityResult = {
  requestToken: string;
  corpId: string;
  userId: string;
  relayIssuer: string;
};

export class WeComRelayError extends Error {
  readonly code: "access_denied" | "identity_exchange_failed" | "invalid_relay_result" | "relay_unavailable";

  constructor(
    message: string,
    code: WeComRelayError["code"] = "relay_unavailable",
  ) {
    super(message);
    this.name = "WeComRelayError";
    this.code = code;
  }
}

function relaySharedKey() {
  const raw = process.env.WECOM_RELAY_SHARED_KEY?.trim() || "";
  const key = Buffer.from(raw, "base64url");
  if (!raw || key.length !== 32 || key.toString("base64url") !== raw.replace(/=+$/, "")) {
    throw new WeComRelayError("企业微信中继共享密钥未正确配置");
  }
  return key;
}

export function sealWeComRelayPayload(value: unknown, nonce = randomBytes(12)) {
  const cipher = createCipheriv("aes-256-gcm", relaySharedKey(), nonce);
  cipher.setAAD(TICKET_AAD);
  const ciphertext = Buffer.concat([
    cipher.update(JSON.stringify(value), "utf8"),
    cipher.final(),
  ]);
  return `v1.${nonce.toString("base64url")}.${Buffer.concat([
    ciphertext,
    cipher.getAuthTag(),
  ]).toString("base64url")}`;
}

export function openWeComRelayPayload(value: string): unknown {
  if (!value || value.length > TICKET_MAX_LENGTH) {
    throw new WeComRelayError("企业微信中继结果格式无效", "invalid_relay_result");
  }
  const parts = value.split(".");
  if (parts.length !== 3 || parts[0] !== "v1") {
    throw new WeComRelayError("企业微信中继结果格式无效", "invalid_relay_result");
  }
  try {
    const nonce = Buffer.from(parts[1], "base64url");
    const sealed = Buffer.from(parts[2], "base64url");
    if (nonce.length !== 12 || sealed.length <= 16) throw new Error("invalid ticket");
    const decipher = createDecipheriv("aes-256-gcm", relaySharedKey(), nonce);
    decipher.setAAD(TICKET_AAD);
    decipher.setAuthTag(sealed.subarray(sealed.length - 16));
    const plaintext = Buffer.concat([
      decipher.update(sealed.subarray(0, sealed.length - 16)),
      decipher.final(),
    ]).toString("utf8");
    return JSON.parse(plaintext) as unknown;
  } catch {
    throw new WeComRelayError("企业微信中继结果签名无效", "invalid_relay_result");
  }
}

function relayEndpoints(relayCallbackUrl: string) {
  const callback = new URL(relayCallbackUrl);
  if (
    !["http:", "https:"].includes(callback.protocol)
    || callback.username
    || callback.password
    || callback.pathname !== "/callbacks/wecom"
    || callback.search
    || callback.hash
  ) {
    throw new WeComRelayError("企业微信中继地址无效");
  }
  return {
    stage: new URL("/api/wecom/authorizations", callback.origin),
    authorize: new URL("/authorize/wecom", callback.origin),
    issuer: `${callback.origin}/wecom`,
  };
}

export async function provisionWeComRelayAuthorization(input: {
  requestToken: string;
  expiresAt: string;
  credential: WeComRelayCredential;
}) {
  const authorizationId = randomBytes(32).toString("base64url");
  const endpoints = relayEndpoints(input.credential.relayCallbackUrl);
  // The platform-side link request may outlive the Relay handoff, but the
  // credential-bearing ticket must stay within the Relay's 10-minute limit.
  const expiresAt = Math.floor(Math.min(
    new Date(input.expiresAt).getTime(),
    Date.now() + AUTHORIZATION_TICKET_LIFETIME_MS,
  ) / 1_000);
  const ticket = sealWeComRelayPayload({
    v: TICKET_VERSION,
    authorization_id: authorizationId,
    request_token: input.requestToken,
    corp_id: input.credential.corpId,
    app_secret: input.credential.appSecret,
    callback_url: wecomIdentityLinkCompletionUrl().toString(),
    expires_at: expiresAt,
  });
  let response: Response;
  try {
    response = await fetch(endpoints.stage, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ ticket }),
      cache: "no-store",
      signal: AbortSignal.timeout(8_000),
    });
  } catch {
    throw new WeComRelayError("企业微信认证中继当前不可用");
  }
  const body = await response.json().catch(() => undefined) as { authorizationId?: unknown } | undefined;
  if (!response.ok || body?.authorizationId !== authorizationId) {
    throw new WeComRelayError("企业微信认证中继拒绝了绑定请求");
  }
  endpoints.authorize.searchParams.set("id", authorizationId);
  return endpoints.authorize;
}

function resultPayload(value: unknown): RelayResultPayload {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new WeComRelayError("企业微信中继结果内容无效", "invalid_relay_result");
  }
  const record = value as Record<string, unknown>;
  const allowed = new Set([
    "v", "authorization_id", "request_token", "corp_id", "user_id", "error", "issued_at", "expires_at",
  ]);
  if (Object.keys(record).some((key) => !allowed.has(key))) {
    throw new WeComRelayError("企业微信中继结果包含未知字段", "invalid_relay_result");
  }
  return record as RelayResultPayload;
}

export function readWeComRelayResultRequestToken(ticket: string) {
  const payload = resultPayload(openWeComRelayPayload(ticket));
  if (payload.v !== TICKET_VERSION || !SECRET_PATTERN.test(payload.request_token)) {
    throw new WeComRelayError("企业微信中继结果格式无效", "invalid_relay_result");
  }
  return payload.request_token;
}

export function verifyWeComRelayResult(
  ticket: string,
  relayCallbackUrl: string,
  now = Math.floor(Date.now() / 1_000),
): WeComRelayIdentityResult {
  const payload = resultPayload(openWeComRelayPayload(ticket));
  if (
    payload.v !== TICKET_VERSION
    || !SECRET_PATTERN.test(payload.authorization_id)
    || !SECRET_PATTERN.test(payload.request_token)
    || !Number.isInteger(payload.issued_at)
    || !Number.isInteger(payload.expires_at)
    || payload.issued_at > now + 30
    || payload.expires_at <= now - 30
    || payload.expires_at - payload.issued_at !== RESULT_LIFETIME_SECONDS
  ) {
    throw new WeComRelayError("企业微信中继结果已过期或格式无效", "invalid_relay_result");
  }
  if (payload.error) {
    if (payload.error === "access_denied") {
      throw new WeComRelayError("用户取消了企业微信认证", "access_denied");
    }
    if (payload.error === "identity_exchange_failed") {
      throw new WeComRelayError("企业微信中继未能获取员工身份", "identity_exchange_failed");
    }
    throw new WeComRelayError("企业微信中继返回了未知错误", "invalid_relay_result");
  }
  if (
    typeof payload.corp_id !== "string"
    || !payload.corp_id.trim()
    || payload.corp_id.length > 255
    || typeof payload.user_id !== "string"
    || !payload.user_id.trim()
    || payload.user_id.length > USER_ID_MAX_LENGTH
  ) {
    throw new WeComRelayError("企业微信中继未返回有效员工身份", "invalid_relay_result");
  }
  return {
    requestToken: payload.request_token,
    corpId: payload.corp_id,
    userId: payload.user_id,
    relayIssuer: relayEndpoints(relayCallbackUrl).issuer,
  };
}
