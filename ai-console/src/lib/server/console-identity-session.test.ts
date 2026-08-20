import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  headers: vi.fn(),
  getLinkedIdentity: vi.fn(),
}));

vi.mock("next/headers", () => ({ headers: mocks.headers }));
vi.mock("./integrations", () => ({
  getWeComLinkedPlatformIdentity: mocks.getLinkedIdentity,
}));

import { getConsoleIdentity } from "./console-identity";
import {
  issueWeComConsoleSession,
  WECOM_CONSOLE_SESSION_COOKIE,
} from "./wecom-console-session";

const originalDevIdentity = process.env.AI_CONSOLE_DEV_IDENTITY_ENABLED;
const originalEncryptionKey = process.env.AI_CONSOLE_SECRET_ENCRYPTION_KEY;
const originalAdminEmails = process.env.AI_CONSOLE_ADMIN_EMAILS;

beforeEach(() => {
  vi.clearAllMocks();
  process.env.AI_CONSOLE_DEV_IDENTITY_ENABLED = "false";
  process.env.AI_CONSOLE_SECRET_ENCRYPTION_KEY = "test-console-identity-session-secret-value";
  process.env.AI_CONSOLE_ADMIN_EMAILS = "admin@example.com";
});

afterEach(() => {
  if (originalDevIdentity === undefined) delete process.env.AI_CONSOLE_DEV_IDENTITY_ENABLED;
  else process.env.AI_CONSOLE_DEV_IDENTITY_ENABLED = originalDevIdentity;
  if (originalEncryptionKey === undefined) delete process.env.AI_CONSOLE_SECRET_ENCRYPTION_KEY;
  else process.env.AI_CONSOLE_SECRET_ENCRYPTION_KEY = originalEncryptionKey;
  if (originalAdminEmails === undefined) delete process.env.AI_CONSOLE_ADMIN_EMAILS;
  else process.env.AI_CONSOLE_ADMIN_EMAILS = originalAdminEmails;
});

function sessionHeaders() {
  const token = issueWeComConsoleSession({
    principalIssuer: "https://ai.example.com/oauth",
    principalSubject: "usr_employee",
    email: "employee@example.com",
    name: "旧名称",
  }, "11111111-1111-4111-8111-111111111111");
  return new Headers({ cookie: `${WECOM_CONSOLE_SESSION_COOKIE}=${token}` });
}

describe("Console identity from a linked WeCom session", () => {
  it("re-reads the current binding before accepting the signed cookie", async () => {
    mocks.headers.mockResolvedValue(sessionHeaders());
    mocks.getLinkedIdentity.mockResolvedValue({
      principalIssuer: "https://ai.example.com/oauth",
      principalSubject: "usr_employee",
      email: "admin@example.com",
      name: "当前名称",
    });

    await expect(getConsoleIdentity()).resolves.toMatchObject({
      principalSubject: "usr_employee",
      email: "admin@example.com",
      name: "当前名称",
      groups: [],
      isAdmin: true,
    });
    expect(mocks.getLinkedIdentity).toHaveBeenCalledWith(
      "https://ai.example.com/oauth",
      "usr_employee",
      "11111111-1111-4111-8111-111111111111",
    );
  });

  it("rejects the cookie immediately after the binding is revoked", async () => {
    mocks.headers.mockResolvedValue(sessionHeaders());
    mocks.getLinkedIdentity.mockResolvedValue(undefined);

    await expect(getConsoleIdentity()).rejects.toThrow("绑定已解除");
  });
});
