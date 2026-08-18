import { NextRequest } from "next/server";
import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  getIdentity: vi.fn(),
  completeLink: vi.fn(),
  issueSession: vi.fn(),
}));

vi.mock("@/lib/server/console-identity", () => ({
  ConsoleAuthError: class ConsoleAuthError extends Error { status = 401; },
  getConsoleIdentity: mocks.getIdentity,
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
  completeVerifiedWeComIdentityLinkRequest: mocks.completeLink,
}));
vi.mock("@/lib/server/wecom-identity-link-routing", async () => (
  import("../../../../lib/server/wecom-identity-link-routing")
));
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

describe("first WeCom identity link", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    process.env.AI_CONSOLE_PUBLIC_URL = "https://ai-console.example.com";
  });

  it("binds the verified relay identity to the Pomerium platform identity", async () => {
    const identity = {
      principalIssuer: "https://ai.example.com/oauth",
      principalSubject: "usr_employee",
      email: "employee@example.com",
      name: "张三",
    };
    mocks.getIdentity.mockResolvedValue(identity);
    mocks.completeLink.mockResolvedValue({ linked: true });
    mocks.issueSession.mockReturnValue("signed-console-session");
    const requestToken = "r".repeat(43);
    const request = new NextRequest(
      `https://ai-console.example.com/auth/wework/link?request=${requestToken}`,
      { headers: { cookie: "ai_base_wecom_identity_link=browser-nonce" } },
    );
    const { GET } = await import("./route");

    const response = await GET(request);

    expect(mocks.completeLink).toHaveBeenCalledWith(requestToken, "browser-nonce", identity);
    expect(response.status).toBe(303);
    expect(response.headers.get("location")).toBe(
      "https://ai-console.example.com/account?wecom_link=linked",
    );
    expect(response.headers.get("set-cookie")).toContain(
      "ai_base_wecom_session=signed-console-session",
    );
  });
});
