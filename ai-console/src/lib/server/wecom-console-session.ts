import {
  createHash,
  createHmac,
  timingSafeEqual,
} from "node:crypto";

export const WECOM_CONSOLE_SESSION_COOKIE = "ai_base_wecom_session";
export const WECOM_CONSOLE_SESSION_LIFETIME_SECONDS = 12 * 60 * 60;

const SESSION_VERSION = "v1";
const SESSION_ISSUER = "ai-base-wecom-link";
const SESSION_MAX_LENGTH = 4_096;
const SESSION_CLOCK_SKEW_SECONDS = 30;

export type WeComConsoleSessionClaims = {
  principalIssuer: string;
  principalSubject: string;
  email: string;
  name: string;
  issuedAt: number;
  expiresAt: number;
};

type SessionPayload = {
  v: 1;
  iss: typeof SESSION_ISSUER;
  principal_issuer: string;
  principal_subject: string;
  email: string;
  name: string;
  iat: number;
  exp: number;
};

export class WeComConsoleSessionError extends Error {
  constructor(message = "企业微信自动登录会话无效") {
    super(message);
    this.name = "WeComConsoleSessionError";
  }
}

function sessionKey() {
  const secret = process.env.AI_CONSOLE_SECRET_ENCRYPTION_KEY?.trim();
  if (!secret || secret.length < 32) {
    throw new WeComConsoleSessionError("企业微信自动登录会话密钥未配置");
  }
  return createHash("sha256")
    .update("ai-base-wecom-console-session\0", "utf8")
    .update(secret, "utf8")
    .digest();
}

function sessionSignature(payload: string) {
  return createHmac("sha256", sessionKey())
    .update(`${SESSION_VERSION}.${payload}`, "utf8")
    .digest();
}

function requiredString(value: unknown, maxLength: number) {
  return typeof value === "string" && value.trim() && value.length <= maxLength
    ? value.trim()
    : undefined;
}

function parsePayload(value: unknown): SessionPayload {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new WeComConsoleSessionError();
  }
  const record = value as Record<string, unknown>;
  const allowedKeys = new Set([
    "v", "iss", "principal_issuer", "principal_subject", "email", "name", "iat", "exp",
  ]);
  if (Object.keys(record).some((key) => !allowedKeys.has(key))) {
    throw new WeComConsoleSessionError();
  }
  if (
    record.v !== 1
    || record.iss !== SESSION_ISSUER
    || !requiredString(record.principal_issuer, 1_024)
    || !requiredString(record.principal_subject, 1_024)
    || !requiredString(record.email, 320)
    || !requiredString(record.name, 512)
    || !Number.isInteger(record.iat)
    || !Number.isInteger(record.exp)
  ) {
    throw new WeComConsoleSessionError();
  }
  return record as SessionPayload;
}

export function issueWeComConsoleSession(
  identity: Pick<WeComConsoleSessionClaims, "principalIssuer" | "principalSubject" | "email" | "name">,
  now = Math.floor(Date.now() / 1_000),
) {
  const payload: SessionPayload = {
    v: 1,
    iss: SESSION_ISSUER,
    principal_issuer: identity.principalIssuer.trim(),
    principal_subject: identity.principalSubject.trim(),
    email: identity.email.trim().toLowerCase(),
    name: identity.name.trim(),
    iat: now,
    exp: now + WECOM_CONSOLE_SESSION_LIFETIME_SECONDS,
  };
  parsePayload(payload);
  const encoded = Buffer.from(JSON.stringify(payload), "utf8").toString("base64url");
  return `${SESSION_VERSION}.${encoded}.${sessionSignature(encoded).toString("base64url")}`;
}

export function verifyWeComConsoleSession(
  token: string,
  now = Math.floor(Date.now() / 1_000),
): WeComConsoleSessionClaims {
  if (!token || token.length > SESSION_MAX_LENGTH) throw new WeComConsoleSessionError();
  const parts = token.split(".");
  if (parts.length !== 3 || parts[0] !== SESSION_VERSION || !parts[1] || !parts[2]) {
    throw new WeComConsoleSessionError();
  }
  let receivedSignature: Buffer;
  try {
    receivedSignature = Buffer.from(parts[2], "base64url");
  } catch {
    throw new WeComConsoleSessionError();
  }
  const expectedSignature = sessionSignature(parts[1]);
  if (
    receivedSignature.length !== expectedSignature.length
    || !timingSafeEqual(receivedSignature, expectedSignature)
  ) {
    throw new WeComConsoleSessionError();
  }
  let payload: SessionPayload;
  try {
    payload = parsePayload(JSON.parse(Buffer.from(parts[1], "base64url").toString("utf8")) as unknown);
  } catch (error) {
    if (error instanceof WeComConsoleSessionError) throw error;
    throw new WeComConsoleSessionError();
  }
  if (
    payload.iat > now + SESSION_CLOCK_SKEW_SECONDS
    || payload.exp <= now - SESSION_CLOCK_SKEW_SECONDS
    || payload.exp - payload.iat !== WECOM_CONSOLE_SESSION_LIFETIME_SECONDS
  ) {
    throw new WeComConsoleSessionError("企业微信自动登录会话已过期");
  }
  return {
    principalIssuer: payload.principal_issuer,
    principalSubject: payload.principal_subject,
    email: payload.email,
    name: payload.name,
    issuedAt: payload.iat,
    expiresAt: payload.exp,
  };
}

export function readWeComConsoleSessionCookie(cookieHeader: string | null) {
  if (!cookieHeader) return undefined;
  for (const part of cookieHeader.split(";")) {
    const separator = part.indexOf("=");
    if (separator < 0 || part.slice(0, separator).trim() !== WECOM_CONSOLE_SESSION_COOKIE) continue;
    const value = part.slice(separator + 1).trim();
    if (!value) return undefined;
    try {
      return decodeURIComponent(value);
    } catch {
      return undefined;
    }
  }
  return undefined;
}

export function wecomConsoleSessionCookieOptions(maxAge = WECOM_CONSOLE_SESSION_LIFETIME_SECONDS) {
  return {
    httpOnly: true,
    maxAge,
    path: "/",
    sameSite: "lax" as const,
    secure: true,
  };
}
