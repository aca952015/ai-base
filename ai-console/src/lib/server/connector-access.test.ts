import { describe, expect, it } from "vitest";

import { hardDeniedConnectorActionIds } from "./connector-access";

describe("controlled shared connector Action policy", () => {
  it("allows the static WeCom directory action while keeping dynamic and webhook entry points hard denied", () => {
    expect(hardDeniedConnectorActionIds).not.toContain("wecom_bot.get_userlist");
    expect(hardDeniedConnectorActionIds).toContain("wecom_bot.call_tool");
    expect(hardDeniedConnectorActionIds).toContain("wecom_bot.send_text_message");
  });
});
