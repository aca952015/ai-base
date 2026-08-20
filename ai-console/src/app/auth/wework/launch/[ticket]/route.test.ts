import { NextRequest } from "next/server";
import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  consume: vi.fn(),
  createLogin: vi.fn(),
  getOrganizationId: vi.fn(),
  issueSession: vi.fn(),
  readHandoff: vi.fn(),
  resolveLogin: vi.fn(),
}));

vi.mock("@/lib/server/integrations", () => ({
  IntegrationStoreError: class IntegrationStoreError extends Error {
    code?: string;
  },
  createWeComIdentityLoginRequest: mocks.createLogin,
  resolveWeComIdentityLoginRequest: mocks.resolveLogin,
}));
vi.mock("@/lib/server/wecom-authentication", () => ({
  getWeComOrganizationIdForRelay: mocks.getOrganizationId,
}));
vi.mock("@/lib/server/wecom-relay", () => ({
  WeComRelayError: class WeComRelayError extends Error {
    code = "invalid_relay_result";
  },
  consumeWeComRelayIdentity: mocks.consume,
  readWeComRelayResultHandoff: mocks.readHandoff,
}));
vi.mock("@/lib/server/wecom-console-session", () => ({
  WECOM_CONSOLE_SESSION_COOKIE: "ai_base_wecom_session",
  issueWeComConsoleSession: mocks.issueSession,
  wecomConsoleSessionCookieOptions: () => ({
    httpOnly: true,
    maxAge: 43_200,
    path: "/",
    sameSite: "lax",
    secure: true,
  }),
}));
vi.mock("@/lib/server/wecom-identity-link-routing", async () => (
  import("../../../../../lib/server/wecom-identity-link-routing")
));

const handoff = {
  relayCallbackUrl: "https://tn2.example.com/callbacks/wecom",
};
const relayIdentity = {
  corpId: "ww-example",
  userId: "ZhangSan",
  relayIssuer: "https://tn2.example.com/wecom",
};

function request(ticket = "v1.encrypted-result-ticket", query = "") {
  return new NextRequest(`https://ai-console.example.com/auth/wework/launch/${ticket}${query}`);
}

describe("WeCom Relay result path", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    process.env.AI_CONSOLE_PUBLIC_URL = "https://ai-console.example.com";
    mocks.readHandoff.mockReturnValue(handoff);
    mocks.getOrganizationId.mockResolvedValue("11111111-1111-4111-8111-111111111111");
    mocks.consume.mockResolvedValue(relayIdentity);
    mocks.createLogin.mockResolvedValue({
      requestToken: "q".repeat(43),
      browserNonce: "browser-nonce",
      expiresAt: new Date(Date.now() + 30 * 60_000).toISOString(),
    });
    mocks.issueSession.mockReturnValue("signed-console-session");
  });

  it("consumes the path result server-side and restores an existing binding", async () => {
    const identity = {
      principalIssuer: "https://ai.example.com/oauth",
      principalSubject: "usr_employee",
      email: "employee@example.com",
      name: "张三",
      linkId: "22222222-2222-4222-8222-222222222222",
      organizationId: "11111111-1111-4111-8111-111111111111",
    };
    mocks.resolveLogin.mockResolvedValue({ status: "linked", identity });
    const { GET } = await import("./route");
    const response = await GET(request(), {
      params: Promise.resolve({ ticket: "v1.encrypted-result-ticket" }),
    });

    expect(mocks.readHandoff).toHaveBeenCalledWith("v1.encrypted-result-ticket");
    expect(mocks.getOrganizationId).toHaveBeenCalledWith(handoff.relayCallbackUrl);
    expect(mocks.consume).toHaveBeenCalledWith("v1.encrypted-result-ticket", handoff);
    expect(mocks.createLogin).toHaveBeenCalledWith(identity.organizationId);
    expect(mocks.resolveLogin).toHaveBeenCalledWith(
      "q".repeat(43),
      "browser-nonce",
      relayIdentity,
    );
    expect(mocks.issueSession).toHaveBeenCalledWith(identity, identity.linkId);
    expect(response.status).toBe(303);
    expect(response.headers.get("location")).toBe(
      "https://ai-console.example.com/account?wecom_link=restored",
    );
    expect(response.headers.get("set-cookie")).toContain(
      "ai_base_wecom_session=signed-console-session",
    );
  });

  it("keeps the browser nonce only when first platform binding is required", async () => {
    mocks.resolveLogin.mockResolvedValue({ status: "login_required" });
    const { GET } = await import("./route");
    const response = await GET(request(), {
      params: Promise.resolve({ ticket: "v1.encrypted-result-ticket" }),
    });

    expect(response.status).toBe(303);
    expect(response.headers.get("location")).toBe(
      `https://ai-console.example.com/auth/wework/link?request=${"q".repeat(43)}`,
    );
    expect(response.headers.get("set-cookie")).toContain(
      "ai_base_wecom_identity_link=browser-nonce",
    );
    expect(mocks.issueSession).not.toHaveBeenCalled();
  });

  it("rejects browser-controlled query parameters before consuming the result", async () => {
    const { GET } = await import("./route");
    const response = await GET(request("valid-ticket", "?organization=browser"), {
      params: Promise.resolve({ ticket: "valid-ticket" }),
    });

    expect(response.status).toBe(303);
    expect(response.headers.get("location")).toBe(
      "https://ai-console.example.com/auth/wework/status?result=failed",
    );
    expect(mocks.readHandoff).not.toHaveBeenCalled();
  });
});
