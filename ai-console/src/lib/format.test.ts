import { describe, expect, it } from "vitest";

import { formatDateTime } from "./format";

describe("formatDateTime", () => {
  it("uses a stable China timezone on the server and in the browser", () => {
    expect(formatDateTime("2026-08-05T06:13:56.000Z")).toBe("08/05 14:13");
  });
});
