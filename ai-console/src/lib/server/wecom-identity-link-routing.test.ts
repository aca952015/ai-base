import { afterEach, describe, expect, it } from "vitest";

import {
  aiConsoleAudience,
  wecomIdentityLinkCompletionUrl,
  wecomIdentityLinkCookieOptions,
  wecomIdentityLinkResultUrl,
} from "./wecom-identity-link-routing";

const originalConsoleUrl = process.env.AI_CONSOLE_PUBLIC_URL;

afterEach(() => {
  if (originalConsoleUrl === undefined) delete process.env.AI_CONSOLE_PUBLIC_URL;
  else process.env.AI_CONSOLE_PUBLIC_URL = originalConsoleUrl;
});

describe("WeCom identity link routing", () => {
  it("keeps completion and results behind the authenticated main Console", () => {
    expect(wecomIdentityLinkCompletionUrl().toString()).toBe(
      "https://ai-console.localhost.pomerium.io:8443/auth/wework/complete",
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
