import { describe, expect, it } from "vitest";

import { parseActionRequest } from "./actions";

describe("action request parsing", () => {
  it.each(["check-health", "sync-knowledge", "run-evaluation"])(
    "accepts %s",
    (action) => expect(parseActionRequest({ action })).toEqual({ ok: true, action }),
  );

  it("rejects unsupported actions", () => {
    expect(parseActionRequest({ action: "rotate-connection" })).toEqual({
      ok: false,
      error: "action must be one of: check-health, sync-knowledge, run-evaluation",
    });
  });
});
