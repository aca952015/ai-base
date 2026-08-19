import { afterEach, describe, expect, it } from "vitest";

import {
  aiConsoleAudience,
  wecomIdentityLinkCompletionUrl,
  wecomIdentityLinkCookieOptions,
  wecomIdentityLinkLoginUrl,
  wecomIdentityLinkResultUrl,
  wecomIdentityStatusUrl,
  wecomIdentityStartUrl,
} from "./wecom-identity-link-routing";

const originalConsoleUrl = process.env.AI_CONSOLE_PUBLIC_URL;

afterEach(() => {
  if (originalConsoleUrl === undefined) delete process.env.AI_CONSOLE_PUBLIC_URL;
  else process.env.AI_CONSOLE_PUBLIC_URL = originalConsoleUrl;
});

describe("WeCom identity link routing", () => {
  it("separates the public relay completion from the authenticated first-link handoff", () => {
    const organizationId = "11111111-1111-4111-8111-111111111111";
    expect(wecomIdentityLinkCompletionUrl().toString()).toBe(
      "https://ai-console.localhost.pomerium.io:8443/auth/wework/complete",
    );
    expect(wecomIdentityStartUrl(organizationId).toString()).toBe(
      `https://ai-console.localhost.pomerium.io:8443/auth/wework?organization=${organizationId}`,
    );
    expect(wecomIdentityLinkLoginUrl("opaque-request").toString()).toBe(
      "https://ai-console.localhost.pomerium.io:8443/auth/wework/link?request=opaque-request",
    );
    expect(wecomIdentityStatusUrl("denied", organizationId).toString()).toBe(
      `https://ai-console.localhost.pomerium.io:8443/auth/wework/status?result=denied&organization=${organizationId}`,
    );
    expect(wecomIdentityLinkResultUrl("linked").toString()).toBe(
      "https://ai-console.localhost.pomerium.io:8443/account?wecom_link=linked",
    );
    expect(aiConsoleAudience()).toBe("ai-console.localhost.pomerium.io");
  });

  it("creates a host-only secure browser binding cookie", () => {
    expect(wecomIdentityLinkCookieOptions(600)).toEqual({
      httpOnly: true,
      maxAge: 600,
      path: "/auth/wework",
      sameSite: "lax",
      secure: true,
    });
  });

  it("rejects non-HTTPS or path-bearing Console origins", () => {
    process.env.AI_CONSOLE_PUBLIC_URL = "http://console.example.com";
    expect(() => wecomIdentityLinkCompletionUrl()).toThrow("HTTPS");
    process.env.AI_CONSOLE_PUBLIC_URL = "https://console.example.com/base";
    expect(() => wecomIdentityLinkCompletionUrl()).toThrow("Origin");
  });
});
