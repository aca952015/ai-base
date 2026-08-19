import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  getIdentity: vi.fn(),
  start: vi.fn(),
  poll: vi.fn(),
}));

vi.mock("@/lib/server/console-identity", () => ({
  ConsoleAuthError: class ConsoleAuthError extends Error { status = 401; },
  getConsoleIdentity: mocks.getIdentity,
}));
vi.mock("@/lib/server/integrations", () => ({
  IntegrationStoreError: class IntegrationStoreError extends Error { status = 409; },
  startEmployeeWeComBotAuthorization: mocks.start,
  pollEmployeeWeComBotAuthorization: mocks.poll,
}));
vi.mock("@/lib/server/open-connector", () => ({
  OpenConnectorError: class OpenConnectorError extends Error { status = 502; },
}));
vi.mock("@/lib/server/wecom-bot-qr", () => ({
  WeComBotQrError: class WeComBotQrError extends Error { status = 502; },
}));

describe("personal WeCom bot authorization route", () => {
  beforeEach(() => vi.clearAllMocks());

  it("starts a QR session for the current platform identity", async () => {
    const identity = { principalIssuer: "https://ai.example.com/oauth", principalSubject: "usr_employee" };
    mocks.getIdentity.mockResolvedValue(identity);
    mocks.start.mockResolvedValue({
      request: "r".repeat(43),
      pageUrl: "https://work.weixin.qq.com/ai/qc/gen?source=ai_base_external&scode=code",
      expiresAt: "2026-08-19T00:05:00.000Z",
    });
    const { POST } = await import("./route");

    const response = await POST();

    expect(response.status).toBe(201);
    expect(mocks.start).toHaveBeenCalledWith(identity);
    expect(await response.json()).not.toHaveProperty("scode");
  });

  it("polls the identity-bound request without returning bot credentials", async () => {
    const identity = { principalIssuer: "https://ai.example.com/oauth", principalSubject: "usr_employee" };
    mocks.getIdentity.mockResolvedValue(identity);
    mocks.poll.mockResolvedValue({ status: "connected", connectionName: "usr_private_bot" });
    const { GET } = await import("./route");

    const response = await GET(new Request(`https://ai.example.com/api/account/wecom-bots/authorize?request=${"r".repeat(43)}`));
    const payload = await response.json();

    expect(mocks.poll).toHaveBeenCalledWith(identity, "r".repeat(43));
    expect(payload).toEqual({ status: "connected", connectionName: "usr_private_bot" });
    expect(JSON.stringify(payload)).not.toContain("secret");
    expect(JSON.stringify(payload)).not.toContain("botId");
  });

  it("does not expose an upstream error that could contain credentials", async () => {
    mocks.getIdentity.mockResolvedValue({ principalIssuer: "https://ai.example.com/oauth", principalSubject: "usr_employee" });
    const { OpenConnectorError } = await import("@/lib/server/open-connector");
    mocks.poll.mockRejectedValue(new OpenConnectorError("secret=should-never-reach-the-browser"));
    const { GET } = await import("./route");

    const response = await GET(new Request(`https://ai.example.com/api/account/wecom-bots/authorize?request=${"r".repeat(43)}`));
    const payload = await response.json();

    expect(response.status).toBe(502);
    expect(payload).toEqual({ error: "企业微信机器人连接校验失败" });
    expect(JSON.stringify(payload)).not.toContain("should-never-reach-the-browser");
  });
});
