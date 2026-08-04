import {
  createHash,
  verify as verifySignature,
} from "node:crypto";
import { readFile } from "node:fs/promises";

import { headers } from "next/headers";

export type ConsoleIdentity = {
  upstreamIssuer: string;
  upstreamSubject: string;
  principalIssuer: string;
  principalSubject: string;
  email: string;
  name: string;
  groups: string[];
  isAdmin: boolean;
};

type AssertionClaims = {
  aud?: unknown;
  exp?: unknown;
  iss?: unknown;
  nbf?: unknown;
  sub?: unknown;
  email?: unknown;
  name?: unknown;
  groups?: unknown;
};

type AssertionHeader = {
  alg?: unknown;
};

export class ConsoleAuthError extends Error {
  readonly status: number;

  constructor(message: string, status = 401) {
    super(message);
    this.name = "ConsoleAuthError";
    this.status = status;
  }
}

function stringClaim(value: unknown) {
  return typeof value === "string" && value.trim() ? value.trim() : undefined;
}

function stringArrayClaim(value: unknown) {
  if (Array.isArray(value)) {
    return value
      .filter((item): item is string => typeof item === "string" && Boolean(item.trim()))
      .map((item) => item.trim());
  }
  return typeof value === "string"
    ? value.split(",").map((item) => item.trim()).filter(Boolean)
    : [];
}

export function decodePomeriumAssertion(assertion: string | null): AssertionClaims {
  if (!assertion) return {};
  const payload = assertion.split(".")[1];
  if (!payload) return {};
  try {
    const decoded = Buffer.from(payload, "base64url").toString("utf8");
    const claims = JSON.parse(decoded) as unknown;
    return claims && typeof claims === "object" && !Array.isArray(claims)
      ? claims as AssertionClaims
      : {};
  } catch {
    return {};
  }
}

function numericClaim(value: unknown) {
  return typeof value === "number" && Number.isFinite(value) ? value : undefined;
}

function audienceClaim(value: unknown) {
  if (typeof value === "string") return [value];
  return Array.isArray(value)
    ? value.filter((item): item is string => typeof item === "string")
    : [];
}

export function verifyPomeriumAssertion(
  assertion: string,
  publicKey: string,
  options: {
    audience?: string | string[];
    issuer?: string;
    now?: number;
  } = {},
) {
  const parts = assertion.split(".");
  if (parts.length !== 3 || parts.some((part) => !part)) {
    throw new ConsoleAuthError("Pomerium 身份断言格式无效");
  }
  try {
    const header = JSON.parse(Buffer.from(parts[0], "base64url").toString("utf8")) as AssertionHeader;
    if (header.alg !== "ES256") throw new Error("unexpected algorithm");
    const verified = verifySignature(
      "sha256",
      Buffer.from(`${parts[0]}.${parts[1]}`, "utf8"),
      { key: publicKey, dsaEncoding: "ieee-p1363" },
      Buffer.from(parts[2], "base64url"),
    );
    if (!verified) throw new Error("invalid signature");
  } catch {
    throw new ConsoleAuthError("Pomerium 身份断言签名无效");
  }

  const claims = decodePomeriumAssertion(assertion);
  const now = options.now ?? Math.floor(Date.now() / 1_000);
  const expiresAt = numericClaim(claims.exp);
  const notBefore = numericClaim(claims.nbf);
  if (!expiresAt || expiresAt <= now - 30 || (notBefore !== undefined && notBefore > now + 30)) {
    throw new ConsoleAuthError("Pomerium 身份断言已过期或尚未生效");
  }
  if (options.audience) {
    const expectedAudiences = Array.isArray(options.audience)
      ? options.audience
      : [options.audience];
    if (!expectedAudiences.some((audience) => audienceClaim(claims.aud).includes(audience))) {
      throw new ConsoleAuthError("Pomerium 身份断言 Audience 不匹配");
    }
  }
  if (options.issuer && stringClaim(claims.iss)?.replace(/\/$/, "") !== options.issuer.replace(/\/$/, "")) {
    throw new ConsoleAuthError("Pomerium 身份断言 Issuer 不匹配");
  }
  return claims;
}

export function brokerSubject(loginIssuer: string, upstreamSubject: string) {
  return createHash("sha256")
    .update(`${loginIssuer.replace(/\/$/, "")}\0${upstreamSubject}`, "utf8")
    .digest("base64url");
}

function configuredAdminEmails() {
  return new Set(
    (process.env.AI_CONSOLE_ADMIN_EMAILS || "admin@bluetron.cn")
      .split(",")
      .map((email) => email.trim().toLowerCase())
      .filter(Boolean),
  );
}

export function consoleIdentityFromHeaders(input: Headers): ConsoleIdentity {
  const claims = decodePomeriumAssertion(input.get("x-pomerium-jwt-assertion"));
  const email = (
    stringClaim(claims.email)
    || stringClaim(input.get("x-pomerium-claim-email"))
    || ""
  ).toLowerCase();
  const upstreamSubject = stringClaim(claims.sub)
    || stringClaim(input.get("x-pomerium-claim-sub"))
    || stringClaim(input.get("x-pomerium-claim-user"));
  const name = stringClaim(claims.name)
    || stringClaim(input.get("x-pomerium-claim-name"))
    || email.split("@")[0]
    || "企业员工";
  const groups = stringArrayClaim(claims.groups);

  if ((!email || !upstreamSubject) && process.env.AI_CONSOLE_DEV_IDENTITY_ENABLED === "true") {
    const developmentEmail = process.env.AI_CONSOLE_DEV_EMAIL?.trim().toLowerCase() || "admin@bluetron.cn";
    const developmentSubject = process.env.AI_CONSOLE_DEV_SUBJECT?.trim() || "local-development-admin";
    const loginIssuer = (process.env.MCP_LOGIN_OIDC_ISSUER || "http://dex.localtest.me:5556/dex").replace(/\/$/, "");
    return {
      upstreamIssuer: loginIssuer,
      upstreamSubject: developmentSubject,
      principalIssuer: (process.env.MCP_OIDC_ISSUER || "http://127.0.0.1:8080/oauth").replace(/\/$/, ""),
      principalSubject: brokerSubject(loginIssuer, developmentSubject),
      email: developmentEmail,
      name: process.env.AI_CONSOLE_DEV_NAME?.trim() || "本地管理员",
      groups: ["local-development"],
      isAdmin: true,
    };
  }

  if (!email || !upstreamSubject) {
    throw new ConsoleAuthError("未从 Pomerium 获取到完整登录身份");
  }

  const loginIssuer = (process.env.MCP_LOGIN_OIDC_ISSUER || "http://dex.localtest.me:5556/dex").replace(/\/$/, "");
  return {
    upstreamIssuer: loginIssuer,
    upstreamSubject,
    principalIssuer: (process.env.MCP_OIDC_ISSUER || "http://127.0.0.1:8080/oauth").replace(/\/$/, ""),
    principalSubject: brokerSubject(loginIssuer, upstreamSubject),
    email,
    name,
    groups,
    isAdmin: configuredAdminEmails().has(email),
  };
}

export async function getConsoleIdentity() {
  const requestHeaders = await headers();
  if (process.env.AI_CONSOLE_DEV_IDENTITY_ENABLED !== "true") {
    const assertion = requestHeaders.get("x-pomerium-jwt-assertion");
    if (!assertion) throw new ConsoleAuthError("未收到 Pomerium 身份断言");
    const publicKeyPath = process.env.POMERIUM_JWT_PUBLIC_KEY_PATH?.trim();
    if (!publicKeyPath) throw new ConsoleAuthError("Pomerium JWT 公钥未配置", 503);
    const publicKey = await readFile(publicKeyPath, "utf8").catch(() => {
      throw new ConsoleAuthError("无法读取 Pomerium JWT 公钥", 503);
    });
    const audiences = (process.env.POMERIUM_JWT_AUDIENCE || "")
      .split(",")
      .map((audience) => audience.trim())
      .filter(Boolean);
    verifyPomeriumAssertion(assertion, publicKey, {
      audience: audiences.length ? audiences : undefined,
      issuer: process.env.POMERIUM_JWT_ISSUER?.trim() || undefined,
    });
  }
  return consoleIdentityFromHeaders(requestHeaders);
}

export async function requireConsoleAdmin() {
  const identity = await getConsoleIdentity();
  if (!identity.isAdmin) throw new ConsoleAuthError("仅管理员可以访问该功能", 403);
  return identity;
}
