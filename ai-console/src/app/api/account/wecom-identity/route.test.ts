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

  it("clears the automatic Console session after revoking the binding", async () => {
    const identity = {
      principalIssuer: "https://ai.example.com/oauth",
      principalSubject: "usr_employee",
    };
    mocks.getIdentity.mockResolvedValue(identity);
    mocks.disconnect.mockResolvedValue({ disconnected: true });
    const { DELETE } = await import("./route");

    const response = await DELETE();

    expect(mocks.disconnect).toHaveBeenCalledWith(identity);
    expect(response.status).toBe(200);
    expect(response.headers.get("set-cookie")).toContain("ai_base_wecom_session=");
    expect(response.headers.get("set-cookie")).toContain("Max-Age=0");
  });
});
