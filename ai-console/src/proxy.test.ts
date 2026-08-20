import { NextRequest } from "next/server";
import { afterEach, describe, expect, it } from "vitest";

import {
  issueWeComConsoleSession,
  WECOM_CONSOLE_SESSION_COOKIE,
} from "./lib/server/wecom-console-session";
import { proxy } from "./proxy";

const originalAdminEmails = process.env.AI_CONSOLE_ADMIN_EMAILS;
const originalDevIdentity = process.env.AI_CONSOLE_DEV_IDENTITY_ENABLED;
const originalEncryptionKey = process.env.AI_CONSOLE_SECRET_ENCRYPTION_KEY;

afterEach(() => {
  if (originalAdminEmails === undefined) delete process.env.AI_CONSOLE_ADMIN_EMAILS;
  else process.env.AI_CONSOLE_ADMIN_EMAILS = originalAdminEmails;
  if (originalDevIdentity === undefined) delete process.env.AI_CONSOLE_DEV_IDENTITY_ENABLED;
  else process.env.AI_CONSOLE_DEV_IDENTITY_ENABLED = originalDevIdentity;
  if (originalEncryptionKey === undefined) delete process.env.AI_CONSOLE_SECRET_ENCRYPTION_KEY;
  else process.env.AI_CONSOLE_SECRET_ENCRYPTION_KEY = originalEncryptionKey;
});

function authenticatedRequest(pathname: string) {
  const assertion = `header.${Buffer.from(JSON.stringify({
    email: "employee@example.com",
  })).toString("base64url")}.signature`;
  return new NextRequest(`https://ai-console.example.com${pathname}`, {
    headers: {
      "x-pomerium-jwt-assertion": assertion,
    },
  });
}

function wecomSessionRequest(pathname: string, email = "employee@example.com") {
  process.env.AI_CONSOLE_SECRET_ENCRYPTION_KEY = "test-proxy-wecom-session-secret-key-value";
  const session = issueWeComConsoleSession({
    principalIssuer: "https://ai.example.com/oauth",
    principalSubject: "usr_employee",
    email,
    name: "企业员工",
  }, "11111111-1111-4111-8111-111111111111");
  return new NextRequest(`https://ai-console.example.com${pathname}`, {
    headers: { cookie: `${WECOM_CONSOLE_SESSION_COOKIE}=${session}` },
  });
}

describe("console proxy", () => {
  it.each([
    "/auth/wework/launch/v1.encrypted-ticket",
    "/auth/wework/status?result=failed",
  ])(
    "allows the unauthenticated WeCom relay bootstrap route %s",
    (pathname) => {
      process.env.AI_CONSOLE_DEV_IDENTITY_ENABLED = "false";
      const response = proxy(new NextRequest(`https://ai-console.example.com${pathname}`));
      expect(response.status).toBe(200);
      expect(response.headers.get("x-middleware-next")).toBe("1");
    },
  );

  it.each(["/auth/wework", "/auth/wework/complete?result=opaque"])(
    "does not expose the removed WeCom compatibility route %s",
    (pathname) => {
      process.env.AI_CONSOLE_DEV_IDENTITY_ENABLED = "false";
      const response = proxy(new NextRequest(`https://ai-console.example.com${pathname}`));
      expect(response.status).toBe(401);
    },
  );

  it("still redirects employees away from administrator pages", () => {
    process.env.AI_CONSOLE_ADMIN_EMAILS = "admin@example.com";
    process.env.AI_CONSOLE_DEV_IDENTITY_ENABLED = "false";

    const response = proxy(authenticatedRequest("/integrations"));

    expect(response.status).toBe(307);
    expect(response.headers.get("location")).toBe("https://ai-console.example.com/account");
  });

  it("accepts a signed WeCom session but keeps employee admin isolation", () => {
    process.env.AI_CONSOLE_ADMIN_EMAILS = "admin@example.com";
    process.env.AI_CONSOLE_DEV_IDENTITY_ENABLED = "false";

    const account = proxy(wecomSessionRequest("/account"));
    expect(account.status).toBe(200);
    const admin = proxy(wecomSessionRequest("/integrations"));
    expect(admin.status).toBe(307);
    expect(admin.headers.get("location")).toBe("https://ai-console.example.com/account");
  });

  it("clears a forged WeCom session before returning to the protected route", () => {
    process.env.AI_CONSOLE_SECRET_ENCRYPTION_KEY = "test-proxy-wecom-session-secret-key-value";
    process.env.AI_CONSOLE_DEV_IDENTITY_ENABLED = "false";
    const request = new NextRequest("https://ai-console.example.com/account", {
      headers: { cookie: `${WECOM_CONSOLE_SESSION_COOKIE}=v1.forged.signature` },
    });

    const response = proxy(request);

    expect(response.status).toBe(307);
    expect(response.headers.get("location")).toBe("https://ai-console.example.com/account");
    expect(response.headers.get("set-cookie")).toContain(`${WECOM_CONSOLE_SESSION_COOKIE}=`);
    expect(response.headers.get("set-cookie")).toContain("Max-Age=0");
  });
});
