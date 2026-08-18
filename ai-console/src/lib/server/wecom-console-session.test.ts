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
  const identity = {
    principalIssuer: "https://ai.example.com/oauth",
    principalSubject: "usr_employee",
    email: "Employee@Example.com",
    name: "张三",
  };

  it("issues a fixed-lifetime signed session without exposing a reusable credential", () => {
    const now = 1_800_000_000;
    const token = issueWeComConsoleSession(identity, now);

    expect(verifyWeComConsoleSession(token, now + 60)).toEqual({
      ...identity,
      email: "employee@example.com",
      issuedAt: now,
      expiresAt: now + WECOM_CONSOLE_SESSION_LIFETIME_SECONDS,
    });
    expect(token).not.toContain(identity.principalSubject);
  });

  it("rejects tampering, expiry and tokens signed by a rotated key", () => {
    const now = 1_800_000_000;
    const token = issueWeComConsoleSession(identity, now);
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
