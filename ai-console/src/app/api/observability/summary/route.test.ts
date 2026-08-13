import { beforeEach, describe, expect, it, vi } from "vitest";

const requireConsoleAdmin = vi.fn();
const getObservabilitySummary = vi.fn();

vi.mock("@/lib/server/console-identity", () => ({
  ConsoleAuthError: class ConsoleAuthError extends Error { status: number; constructor(message: string, status: number) { super(message); this.status = status; } },
  requireConsoleAdmin,
}));
vi.mock("@/lib/server/observability", () => ({
  getObservabilitySummary,
  parseRange: (value: string | null) => value ?? "1h",
}));

describe("observability summary API", () => {
  beforeEach(() => vi.clearAllMocks());

  it("returns 403 when the caller is not an administrator", async () => {
    const { ConsoleAuthError } = await import("@/lib/server/console-identity");
    requireConsoleAdmin.mockRejectedValue(new ConsoleAuthError("仅管理员可以访问该功能", 403));
    const { GET } = await import("./route");
    const response = await GET(new Request("http://console.test/api/observability/summary?range=1h"));
    expect(response.status).toBe(403);
    expect(await response.json()).toEqual({ error: "仅管理员可以访问该功能" });
    expect(getObservabilitySummary).not.toHaveBeenCalled();
  });
});
