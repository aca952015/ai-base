import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  getIdentity: vi.fn(),
  disconnect: vi.fn(),
}));

vi.mock("@/lib/server/console-identity", () => ({
  ConsoleAuthError: class ConsoleAuthError extends Error { status = 401; },
  getConsoleIdentity: mocks.getIdentity,
}));
vi.mock("@/lib/server/integrations", () => ({
  IntegrationStoreError: class IntegrationStoreError extends Error { status = 500; },
  disconnectWeComIdentityLink: mocks.disconnect,
}));
vi.mock("@/lib/server/wecom-console-session", () => ({
  WECOM_CONSOLE_SESSION_COOKIE: "ai_base_wecom_session",
  wecomConsoleSessionCookieOptions: (maxAge = 43_200) => ({
    httpOnly: true,
    maxAge,
    path: "/",
    sameSite: "lax",
    secure: true,
  }),
}));

describe("WeCom identity unlink", () => {
  beforeEach(() => vi.clearAllMocks());

  it("revokes only the requested organization identity", async () => {
    const identity = {
      principalIssuer: "https://ai.example.com/oauth",
      principalSubject: "usr_employee",
    };
    mocks.getIdentity.mockResolvedValue(identity);
    mocks.disconnect.mockResolvedValue({ disconnected: true });
    const { DELETE } = await import("./route");

    const linkId = "11111111-1111-4111-8111-111111111111";
    const response = await DELETE(new Request(`https://console.example/api/account/wecom-identity?id=${linkId}`));

    expect(mocks.disconnect).toHaveBeenCalledWith(identity, linkId);
    expect(response.status).toBe(200);
    expect(response.headers.get("set-cookie")).toBeNull();
  });
});
