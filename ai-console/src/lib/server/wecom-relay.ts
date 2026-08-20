import {
  createCipheriv,
  createDecipheriv,
  createHmac,
  randomBytes,
} from "node:crypto";

const TICKET_VERSION = 1;
const TICKET_AAD = Buffer.from("ai-base-wecom-relay:v1", "utf8");
const TICKET_MAX_LENGTH = 16 << 10;
const RESULT_LIFETIME_SECONDS = 5 * 60;
const SECRET_PATTERN = /^[A-Za-z0-9_-]{43}$/;
const USER_ID_MAX_LENGTH = 256;
const RESULT_PROOF_HEADER = "X-AI-Base-Relay-Proof";
const RESULT_PROOF_KEY_DOMAIN = "ai-base-wecom-relay:result-consumer-key:v1";
const RESULT_PROOF_DOMAIN = "POST\n/api/wecom/results\n";

type RelayResultHandoffPayload = {
  v: number;
  result_id: string;
  relay_callback_url: string;
  issued_at: number;
  expires_at: number;
};

type RelayIdentityResponse = {
  corp_id: string;
  user_id: string;
  error: string;
};

export type WeComRelayResultHandoff = {
  relayCallbackUrl: string;
};

export type WeComRelayIdentityResult = {
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
    callback.protocol !== "https:"
    || callback.username
    || callback.password
    || callback.pathname !== "/callbacks/wecom"
    || callback.search
    || callback.hash
  ) {
    throw new WeComRelayError("企业微信中继地址无效", "invalid_relay_result");
  }
  return {
    callback: callback.toString(),
    result: new URL("/api/wecom/results", callback.origin),
    issuer: `${callback.origin}/wecom`,
  };
}

export function readWeComRelayResultHandoff(
  ticket: string,
  now = Math.floor(Date.now() / 1_000),
): WeComRelayResultHandoff {
  const value = openWeComRelayPayload(ticket);
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new WeComRelayError("企业微信中继结果票据内容无效", "invalid_relay_result");
  }
  const payload = value as Partial<RelayResultHandoffPayload> & Record<string, unknown>;
  const allowed = new Set(["v", "result_id", "relay_callback_url", "issued_at", "expires_at"]);
  if (
    Object.keys(payload).some((key) => !allowed.has(key))
    || payload.v !== TICKET_VERSION
    || typeof payload.result_id !== "string"
    || !SECRET_PATTERN.test(payload.result_id)
    || typeof payload.relay_callback_url !== "string"
    || !Number.isInteger(payload.issued_at)
    || !Number.isInteger(payload.expires_at)
    || Number(payload.issued_at) > now + 30
    || Number(payload.expires_at) <= now
    || Number(payload.expires_at) - Number(payload.issued_at) !== RESULT_LIFETIME_SECONDS
  ) {
    throw new WeComRelayError("企业微信中继结果票据已过期或格式无效", "invalid_relay_result");
  }
  const endpoints = relayEndpoints(payload.relay_callback_url);
  return {
    relayCallbackUrl: endpoints.callback,
  };
}

export function createWeComRelayResultConsumerProof(ticket: string) {
  const proofKey = createHmac("sha256", relaySharedKey())
    .update(RESULT_PROOF_KEY_DOMAIN, "utf8")
    .digest();
  return createHmac("sha256", proofKey)
    .update(RESULT_PROOF_DOMAIN, "utf8")
    .update(ticket, "utf8")
    .digest("base64url");
}

function identityResponse(value: unknown): RelayIdentityResponse {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new WeComRelayError("企业微信中继身份响应无效", "invalid_relay_result");
  }
  const record = value as Record<string, unknown>;
  const allowed = new Set(["corp_id", "user_id", "error"]);
  if (
    Object.keys(record).some((key) => !allowed.has(key))
    || typeof record.corp_id !== "string"
    || typeof record.user_id !== "string"
    || typeof record.error !== "string"
  ) {
    throw new WeComRelayError("企业微信中继身份响应格式无效", "invalid_relay_result");
  }
  return record as RelayIdentityResponse;
}

export async function consumeWeComRelayIdentity(
  ticket: string,
  handoff = readWeComRelayResultHandoff(ticket),
): Promise<WeComRelayIdentityResult> {
  const endpoints = relayEndpoints(handoff.relayCallbackUrl);
  let response: Response;
  try {
    response = await fetch(endpoints.result, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        [RESULT_PROOF_HEADER]: createWeComRelayResultConsumerProof(ticket),
      },
      body: JSON.stringify({ ticket }),
      cache: "no-store",
      signal: AbortSignal.timeout(8_000),
    });
  } catch {
    throw new WeComRelayError("企业微信认证中继当前不可用");
  }
  const body = await response.json().catch(() => undefined);
  if (!response.ok) {
    if (response.status === 400 || response.status === 410) {
      throw new WeComRelayError("企业微信中继结果已失效或已被消费", "invalid_relay_result");
    }
    throw new WeComRelayError("企业微信认证中继当前不可用");
  }
  const identity = identityResponse(body);
  if (identity.error) {
    if (identity.error === "access_denied") {
      throw new WeComRelayError("用户取消了企业微信认证", "access_denied");
    }
    if (identity.error === "identity_exchange_failed") {
      throw new WeComRelayError("企业微信中继未能获取员工身份", "identity_exchange_failed");
    }
    throw new WeComRelayError("企业微信中继返回了未知错误", "invalid_relay_result");
  }
  if (
    !identity.corp_id.trim()
    || identity.corp_id.length > 255
    || !identity.user_id.trim()
    || identity.user_id.length > USER_ID_MAX_LENGTH
  ) {
    throw new WeComRelayError("企业微信中继未返回有效员工身份", "invalid_relay_result");
  }
  return {
    corpId: identity.corp_id,
    userId: identity.user_id,
    relayIssuer: endpoints.issuer,
  };
}
