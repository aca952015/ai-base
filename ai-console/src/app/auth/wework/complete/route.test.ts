import { NextRequest } from "next/server";
import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  getCredential: vi.fn(),
  verifyRelayResult: vi.fn(),
  resolveLogin: vi.fn(),
  issueSession: vi.fn(),
}));

vi.mock("@/lib/server/integrations", () => ({
  IntegrationStoreError: class IntegrationStoreError extends Error {
    status: number;
    code?: string;
    constructor(message: string, status = 500, code?: string) {
      super(message);
      this.status = status;
      this.code = code;
    }
  },
  resolveWeComIdentityLoginRequest: mocks.resolveLogin,
}));
vi.mock("@/lib/server/wecom-authentication", () => ({
  getWeComRelayCredential: mocks.getCredential,
}));
vi.mock("@/lib/server/wecom-identity-link-routing", async () => (
  import("../../../../lib/server/wecom-identity-link-routing")
));
vi.mock("@/lib/server/wecom-relay", () => ({
  WeComRelayError: class WeComRelayError extends Error { code = "invalid_relay_result"; },
  verifyWeComRelayResult: mocks.verifyRelayResult,
}));
vi.mock("@/lib/server/wecom-console-session", () => ({
  WECOM_CONSOLE_SESSION_COOKIE: "ai_base_wecom_session",
  issueWeComConsoleSession: mocks.issueSession,
  wecomConsoleSessionCookieOptions: (maxAge = 43_200) => ({
    httpOnly: true,
    maxAge,
    path: "/",
    sameSite: "lax",
    secure: true,
  }),
}));

function request() {
  return new NextRequest("https://ai-console.example.com/auth/wework/complete?result=relay-ticket", {
    headers: { cookie: "ai_base_wecom_identity_link=browser-nonce" },
  });
}

describe("WeCom relay completion", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    process.env.AI_CONSOLE_PUBLIC_URL = "https://ai-console.example.com";
    mocks.getCredential.mockResolvedValue({ relayCallbackUrl: "https://relay.example.com/callbacks/wecom" });
    mocks.verifyRelayResult.mockReturnValue({
      requestToken: "r".repeat(43),
      corpId: "ww-example",
      userId: "ZhangSan",
      relayIssuer: "https://relay.example.com/wecom",
    });
    mocks.issueSession.mockReturnValue("signed-console-session");
  });

  it("restores an already-linked platform identity without Pomerium", async () => {
    const identity = {
      principalIssuer: "https://ai.example.com/oauth",
      principalSubject: "usr_employee",
      email: "employee@example.com",
      name: "张三",
    };
    mocks.resolveLogin.mockResolvedValue({ status: "linked", identity });
    const { GET } = await import("./route");

    const response = await GET(request());

    expect(response.status).toBe(303);
    expect(response.headers.get("location")).toBe(
      "https://ai-console.example.com/account?wecom_link=restored",
    );
    expect(mocks.issueSession).toHaveBeenCalledWith(identity);
    const setCookie = response.headers.get("set-cookie") || "";
    expect(setCookie).toContain("ai_base_wecom_session=signed-console-session");
    expect(setCookie).toContain("ai_base_wecom_identity_link=");
  });

  it("requires the platform login only for an unbound WeCom identity", async () => {
    mocks.resolveLogin.mockResolvedValue({ status: "login_required" });
    const { GET } = await import("./route");

    const response = await GET(request());

    expect(response.status).toBe(303);
    expect(response.headers.get("location")).toBe(
      `https://ai-console.example.com/auth/wework/link?request=${"r".repeat(43)}`,
    );
    expect(mocks.issueSession).not.toHaveBeenCalled();
    expect(response.headers.get("set-cookie")).toBeNull();
  });
});
