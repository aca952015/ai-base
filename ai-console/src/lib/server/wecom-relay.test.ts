import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import {
  openWeComRelayPayload,
  provisionWeComRelayAuthorization,
  sealWeComRelayPayload,
  verifyWeComRelayResult,
  WeComRelayError,
} from "./wecom-relay";

const originalSharedKey = process.env.WECOM_RELAY_SHARED_KEY;
const originalConsoleUrl = process.env.AI_CONSOLE_PUBLIC_URL;
const sharedKey = Buffer.from("0123456789abcdef0123456789abcdef").toString("base64url");

beforeEach(() => {
  process.env.WECOM_RELAY_SHARED_KEY = sharedKey;
  process.env.AI_CONSOLE_PUBLIC_URL = "https://ai-console.example.com";
});

afterEach(() => {
  vi.restoreAllMocks();
  if (originalSharedKey === undefined) delete process.env.WECOM_RELAY_SHARED_KEY;
  else process.env.WECOM_RELAY_SHARED_KEY = originalSharedKey;
  if (originalConsoleUrl === undefined) delete process.env.AI_CONSOLE_PUBLIC_URL;
  else process.env.AI_CONSOLE_PUBLIC_URL = originalConsoleUrl;
});

describe("WeCom relay protocol", () => {
  it("authenticates encrypted tickets and rejects tampering", () => {
    const sealed = sealWeComRelayPayload({ value: "sensitive" }, Buffer.alloc(12, 1));
    expect(openWeComRelayPayload(sealed)).toEqual({ value: "sensitive" });
    const parts = sealed.split(".");
    parts[2] = `${parts[2][0] === "A" ? "B" : "A"}${parts[2].slice(1)}`;
    expect(() => openWeComRelayPayload(parts.join("."))).toThrow(WeComRelayError);
  });

  it("provisions credentials through the server channel and returns only an opaque browser URL", async () => {
    const fetchMock = vi.spyOn(globalThis, "fetch").mockImplementation(async (_url, init) => {
      const body = JSON.parse(String(init?.body)) as { ticket: string };
      const payload = openWeComRelayPayload(body.ticket) as Record<string, unknown>;
      expect(payload).toMatchObject({
        v: 1,
        request_token: "r".repeat(43),
        corp_id: "ww-example",
        app_secret: "app-secret",
        callback_url: "https://ai-console.example.com/auth/wework/complete",
      });
      expect(Number(payload.expires_at)).toBeLessThanOrEqual(
        Math.floor((Date.now() + 10 * 60_000) / 1_000),
      );
      return Response.json({ authorizationId: payload.authorization_id }, { status: 201 });
    });
    const authorization = await provisionWeComRelayAuthorization({
      requestToken: "r".repeat(43),
      expiresAt: new Date(Date.now() + 30 * 60_000).toISOString(),
      credential: {
        corpId: "ww-example",
        appSecret: "app-secret",
        relayCallbackUrl: "http://tn1.cofly-ai.cn/callbacks/wecom",
      },
    });
    expect(fetchMock).toHaveBeenCalledWith(
      new URL("http://tn1.cofly-ai.cn/api/wecom/authorizations"),
      expect.objectContaining({ method: "POST" }),
    );
    expect(authorization.origin + authorization.pathname).toBe("http://tn1.cofly-ai.cn/authorize/wecom");
    expect(authorization.searchParams.get("id")).toMatch(/^[A-Za-z0-9_-]{43}$/);
    expect(authorization.toString()).not.toContain("app-secret");
  });

  it("verifies a successful short-lived relay identity and rejects errors or expiry", () => {
    const now = 1_800_000_000;
    const base = {
      v: 1,
      authorization_id: "a".repeat(43),
      request_token: "r".repeat(43),
      issued_at: now,
      expires_at: now + 300,
    };
    const success = sealWeComRelayPayload({ ...base, corp_id: "ww-example", user_id: "ZhangSan" });
    expect(verifyWeComRelayResult(success, "http://tn1.cofly-ai.cn/callbacks/wecom", now)).toEqual({
      requestToken: "r".repeat(43),
      corpId: "ww-example",
      userId: "ZhangSan",
      relayIssuer: "http://tn1.cofly-ai.cn/wecom",
    });

    const denied = sealWeComRelayPayload({ ...base, error: "access_denied" });
    expect(() => verifyWeComRelayResult(denied, "http://tn1.cofly-ai.cn/callbacks/wecom", now))
      .toThrow("用户取消");
    expect(() => verifyWeComRelayResult(success, "http://tn1.cofly-ai.cn/callbacks/wecom", now + 400))
      .toThrow("已过期");
  });
});
