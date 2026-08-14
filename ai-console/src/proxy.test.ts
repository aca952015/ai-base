import { NextRequest } from "next/server";
import { afterEach, describe, expect, it } from "vitest";

import { proxy } from "./proxy";

const originalAdminEmails = process.env.AI_CONSOLE_ADMIN_EMAILS;
const originalDevIdentity = process.env.AI_CONSOLE_DEV_IDENTITY_ENABLED;

afterEach(() => {
  if (originalAdminEmails === undefined) delete process.env.AI_CONSOLE_ADMIN_EMAILS;
  else process.env.AI_CONSOLE_ADMIN_EMAILS = originalAdminEmails;
  if (originalDevIdentity === undefined) delete process.env.AI_CONSOLE_DEV_IDENTITY_ENABLED;
  else process.env.AI_CONSOLE_DEV_IDENTITY_ENABLED = originalDevIdentity;
});

function authenticatedRequest(pathname: string) {
  const assertion = `header.${Buffer.from(JSON.stringify({
    email: "employee@bluetron.cn",
  })).toString("base64url")}.signature`;
  return new NextRequest(`https://ai-console.example.com${pathname}`, {
    headers: {
      "x-pomerium-jwt-assertion": assertion,
    },
  });
}

describe("console proxy", () => {
  it.each(["/auth/wework", "/auth/wework/complete?result=opaque"])(
    "allows authenticated employees to use the WeCom identity link route %s",
    (pathname) => {
      process.env.AI_CONSOLE_ADMIN_EMAILS = "admin@bluetron.cn";
      process.env.AI_CONSOLE_DEV_IDENTITY_ENABLED = "false";

      const response = proxy(authenticatedRequest(pathname));

      expect(response.status).toBe(200);
      expect(response.headers.get("x-middleware-next")).toBe("1");
      expect(response.headers.get("location")).toBeNull();
    },
  );

  it("still redirects employees away from administrator pages", () => {
    process.env.AI_CONSOLE_ADMIN_EMAILS = "admin@bluetron.cn";
    process.env.AI_CONSOLE_DEV_IDENTITY_ENABLED = "false";

    const response = proxy(authenticatedRequest("/integrations"));

    expect(response.status).toBe(307);
    expect(response.headers.get("location")).toBe("https://ai-console.example.com/account");
  });
});
