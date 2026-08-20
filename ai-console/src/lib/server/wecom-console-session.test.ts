import { createHash, createHmac } from "node:crypto";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import {
  issueWeComConsoleSession,
  readWeComConsoleSessionCookie,
  verifyWeComConsoleSession,
  WECOM_CONSOLE_SESSION_COOKIE,
  WECOM_CONSOLE_SESSION_LIFETIME_SECONDS,
  wecomConsoleSessionCookieOptions,
} from "./wecom-console-session";

const originalSecret = process.env.AI_CONSOLE_SECRET_ENCRYPTION_KEY;

beforeEach(() => {
  process.env.AI_CONSOLE_SECRET_ENCRYPTION_KEY = "test-wecom-console-session-secret-32-bytes";
});

afterEach(() => {
  if (originalSecret === undefined) delete process.env.AI_CONSOLE_SECRET_ENCRYPTION_KEY;
  else process.env.AI_CONSOLE_SECRET_ENCRYPTION_KEY = originalSecret;
});

describe("WeCom Console session", () => {
  const linkId = "11111111-1111-4111-8111-111111111111";
  const identity = {
    principalIssuer: "https://ai.example.com/oauth",
    principalSubject: "usr_employee",
    email: "Employee@Example.com",
    name: "张三",
  };

  function legacyToken(now: number) {
    const payload = Buffer.from(JSON.stringify({
      v: 1,
      iss: "ai-base-wecom-link",
      principal_issuer: identity.principalIssuer,
      principal_subject: identity.principalSubject,
      email: identity.email.toLowerCase(),
      name: identity.name,
      iat: now,
      exp: now + WECOM_CONSOLE_SESSION_LIFETIME_SECONDS,
    }), "utf8").toString("base64url");
    const key = createHash("sha256")
      .update("ai-base-wecom-console-session\0", "utf8")
      .update(process.env.AI_CONSOLE_SECRET_ENCRYPTION_KEY!, "utf8")
      .digest();
    const signature = createHmac("sha256", key).update(`v1.${payload}`, "utf8").digest("base64url");
    return `v1.${payload}.${signature}`;
  }

  it("issues a fixed-lifetime signed session without exposing a reusable credential", () => {
    const now = 1_800_000_000;
    const token = issueWeComConsoleSession(identity, linkId, now);

    expect(verifyWeComConsoleSession(token, now + 60)).toEqual({
      ...identity,
      linkId,
      email: "employee@example.com",
      issuedAt: now,
      expiresAt: now + WECOM_CONSOLE_SESSION_LIFETIME_SECONDS,
    });
    expect(token).not.toContain(identity.principalSubject);
  });

  it("can bind the session to the concrete organization identity link", () => {
    const now = 1_800_000_000;
    const token = issueWeComConsoleSession(identity, linkId, now);
    expect(verifyWeComConsoleSession(token, now + 60)).toMatchObject({ linkId });
  });

  it("rejects a valid legacy session that is not bound to a concrete identity link", () => {
    const now = 1_800_000_000;
    expect(() => verifyWeComConsoleSession(legacyToken(now), now)).toThrow("无效");
  });

  it("rejects tampering, expiry and tokens signed by a rotated key", () => {
    const now = 1_800_000_000;
    const token = issueWeComConsoleSession(identity, linkId, now);
    const parts = token.split(".");
    parts[1] = `${parts[1][0] === "A" ? "B" : "A"}${parts[1].slice(1)}`;
    expect(() => verifyWeComConsoleSession(parts.join("."), now)).toThrow("无效");
    expect(() => verifyWeComConsoleSession(
      token,
      now + WECOM_CONSOLE_SESSION_LIFETIME_SECONDS + 31,
    )).toThrow("过期");

    process.env.AI_CONSOLE_SECRET_ENCRYPTION_KEY = "rotated-wecom-console-session-secret-value";
    expect(() => verifyWeComConsoleSession(token, now)).toThrow("无效");
  });

  it("reads only the named host cookie and uses secure HttpOnly options", () => {
    expect(readWeComConsoleSessionCookie(
      `other=1; ${WECOM_CONSOLE_SESSION_COOKIE}=v1.payload.signature; next=2`,
    )).toBe("v1.payload.signature");
    expect(wecomConsoleSessionCookieOptions()).toEqual({
      httpOnly: true,
      maxAge: WECOM_CONSOLE_SESSION_LIFETIME_SECONDS,
      path: "/",
      sameSite: "lax",
      secure: true,
    });
  });
});
