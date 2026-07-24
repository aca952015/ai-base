import {
  createHash,
  generateKeyPairSync,
  sign,
} from "node:crypto";

import { afterEach, describe, expect, it } from "vitest";

import {
  brokerSubject,
  consoleIdentityFromHeaders,
  ConsoleAuthError,
  decodePomeriumAssertion,
  verifyPomeriumAssertion,
} from "./console-identity";

const originalAdminEmails = process.env.AI_CONSOLE_ADMIN_EMAILS;
const originalDevIdentity = process.env.AI_CONSOLE_DEV_IDENTITY_ENABLED;
const originalLoginIssuer = process.env.MCP_LOGIN_OIDC_ISSUER;
const originalMcpIssuer = process.env.MCP_OIDC_ISSUER;

afterEach(() => {
  if (originalAdminEmails === undefined) delete process.env.AI_CONSOLE_ADMIN_EMAILS;
  else process.env.AI_CONSOLE_ADMIN_EMAILS = originalAdminEmails;
  if (originalDevIdentity === undefined) delete process.env.AI_CONSOLE_DEV_IDENTITY_ENABLED;
  else process.env.AI_CONSOLE_DEV_IDENTITY_ENABLED = originalDevIdentity;
  if (originalLoginIssuer === undefined) delete process.env.MCP_LOGIN_OIDC_ISSUER;
  else process.env.MCP_LOGIN_OIDC_ISSUER = originalLoginIssuer;
  if (originalMcpIssuer === undefined) delete process.env.MCP_OIDC_ISSUER;
  else process.env.MCP_OIDC_ISSUER = originalMcpIssuer;
});

function assertion(claims: Record<string, unknown>) {
  return `header.${Buffer.from(JSON.stringify(claims)).toString("base64url")}.signature`;
}

function signedAssertion(claims: Record<string, unknown>) {
  const { privateKey, publicKey } = generateKeyPairSync("ec", { namedCurve: "prime256v1" });
  const header = Buffer.from(JSON.stringify({ alg: "ES256", typ: "JWT" })).toString("base64url");
  const payload = Buffer.from(JSON.stringify(claims)).toString("base64url");
  const signature = sign("sha256", Buffer.from(`${header}.${payload}`), {
    key: privateKey,
    dsaEncoding: "ieee-p1363",
  }).toString("base64url");
  return {
    assertion: `${header}.${payload}.${signature}`,
    publicKey: publicKey.export({ type: "spki", format: "pem" }).toString(),
  };
}

describe("console identity", () => {
  it("derives the same opaque subject contract used by the MCP OAuth broker", () => {
    const issuer = "https://login.example.com/dex";
    const subject = "employee-42";
    const expected = createHash("sha256").update(`${issuer}\0${subject}`).digest("base64url");
    expect(brokerSubject(issuer, subject)).toBe(expected);
  });

  it("reads Pomerium assertion claims and marks configured administrators", () => {
    process.env.AI_CONSOLE_ADMIN_EMAILS = "admin@example.com";
    process.env.MCP_LOGIN_OIDC_ISSUER = "https://login.example.com/dex/";
    process.env.MCP_OIDC_ISSUER = "https://ai.example.com/oauth/";
    const headers = new Headers({
      "x-pomerium-jwt-assertion": assertion({
        sub: "employee-42",
        email: "Admin@Example.com",
        name: "管理员",
        groups: ["platform-admins"],
      }),
    });

    const identity = consoleIdentityFromHeaders(headers);
    expect(identity).toMatchObject({
      upstreamSubject: "employee-42",
      principalIssuer: "https://ai.example.com/oauth",
      email: "admin@example.com",
      name: "管理员",
      groups: ["platform-admins"],
      isAdmin: true,
    });
    expect(identity.principalSubject).toBe(brokerSubject("https://login.example.com/dex", "employee-42"));
  });

  it("fails closed when requests bypass Pomerium", () => {
    process.env.AI_CONSOLE_DEV_IDENTITY_ENABLED = "false";
    expect(() => consoleIdentityFromHeaders(new Headers())).toThrow(ConsoleAuthError);
  });

  it("does not treat malformed assertions as authenticated", () => {
    expect(decodePomeriumAssertion("not-a-jwt")).toEqual({});
  });

  it("verifies Pomerium ES256 signatures, expiry and audience", () => {
    const now = 1_800_000_000;
    const token = signedAssertion({
      sub: "employee-42",
      email: "employee@example.com",
      aud: "ai-console.example.com",
      exp: now + 300,
      nbf: now - 10,
    });
    expect(verifyPomeriumAssertion(token.assertion, token.publicKey, {
      audience: "ai-console.example.com",
      now,
    }).sub).toBe("employee-42");
    const [header, payload, signature] = token.assertion.split(".");
    const tamperedSignature = `${signature[0] === "A" ? "B" : "A"}${signature.slice(1)}`;
    expect(() => verifyPomeriumAssertion(`${header}.${payload}.${tamperedSignature}`, token.publicKey, {
      audience: "ai-console.example.com",
      now,
    })).toThrow("签名无效");
    expect(() => verifyPomeriumAssertion(token.assertion, token.publicKey, {
      audience: "another.example.com",
      now,
    })).toThrow("Audience 不匹配");
  });
});
