import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  disconnect: vi.fn(),
  getIdentity: vi.fn(),
  rename: vi.fn(),
}));

vi.mock("@/lib/server/console-identity", () => ({
  ConsoleAuthError: class ConsoleAuthError extends Error { status = 401; },
  getConsoleIdentity: mocks.getIdentity,
}));
vi.mock("@/lib/server/integrations", () => ({
  disconnectEmployeeWeComBot: mocks.disconnect,
  IntegrationStoreError: class IntegrationStoreError extends Error { status = 404; },
  renameEmployeeWeComBot: mocks.rename,
}));
vi.mock("@/lib/server/open-connector", () => ({
  OpenConnectorError: class OpenConnectorError extends Error { status = 502; },
}));

describe("personal WeCom bot connection route", () => {
  beforeEach(() => vi.clearAllMocks());

  it("disconnects only through the current platform identity", async () => {
    const identity = { principalIssuer: "https://ai.example.com/oauth", principalSubject: "usr_employee" };
    mocks.getIdentity.mockResolvedValue(identity);
    mocks.disconnect.mockResolvedValue({ disconnected: true });
    const { DELETE } = await import("./route");

    const response = await DELETE(new Request("https://ai.example.com"), {
      params: Promise.resolve({ connectionName: "usr_private_bot" }),
    });

    expect(response.status).toBe(200);
    expect(mocks.disconnect).toHaveBeenCalledWith(identity, "usr_private_bot");
    expect(await response.json()).toEqual({ disconnected: true });
  });

  it("does not expose an upstream disconnect error", async () => {
    mocks.getIdentity.mockResolvedValue({ principalIssuer: "https://ai.example.com/oauth", principalSubject: "usr_employee" });
    const { OpenConnectorError } = await import("@/lib/server/open-connector");
    mocks.disconnect.mockRejectedValue(new OpenConnectorError("secret=should-never-reach-the-browser"));
    const { DELETE } = await import("./route");

    const response = await DELETE(new Request("https://ai.example.com"), {
      params: Promise.resolve({ connectionName: "usr_private_bot" }),
    });
    const payload = await response.json();

    expect(response.status).toBe(502);
    expect(payload).toEqual({ error: "企业微信机器人连接解绑失败" });
    expect(JSON.stringify(payload)).not.toContain("should-never-reach-the-browser");
  });

  it("renames only through the current platform identity", async () => {
    const identity = { principalIssuer: "https://ai.example.com/oauth", principalSubject: "usr_employee" };
    mocks.getIdentity.mockResolvedValue(identity);
    mocks.rename.mockResolvedValue({ renamed: true, displayName: "陈英杰绑定的企微机器人 · 52ef" });
    const { PATCH } = await import("./route");

    const response = await PATCH(new Request("https://ai.example.com", {
      method: "PATCH",
      body: JSON.stringify({ displayName: "陈英杰绑定的企微机器人 · 52ef" }),
    }), {
      params: Promise.resolve({ connectionName: "usr_private_bot" }),
    });

    expect(response.status).toBe(200);
    expect(mocks.rename).toHaveBeenCalledWith(
      identity,
      "usr_private_bot",
      "陈英杰绑定的企微机器人 · 52ef",
    );
    expect(await response.json()).toEqual({ renamed: true, displayName: "陈英杰绑定的企微机器人 · 52ef" });
  });
});
