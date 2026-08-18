import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";

import {
  WeComIdentityCard,
  wecomLinkResultMessage,
} from "./account-integration-manager";

describe("WeCom account result messages", () => {
  it("does not show an ambiguous message after automatic login", () => {
    expect(wecomLinkResultMessage("restored")).toBeUndefined();
  });

  it("keeps actionable first-link and error messages", () => {
    expect(wecomLinkResultMessage("linked")?.text).toContain("已与当前平台账号绑定");
    expect(wecomLinkResultMessage("expired")?.tone).toBe("error");
  });
});

describe("WeCom identity card", () => {
  it("does not allow binding before a trusted WeCom identity is received", () => {
    const html = renderToStaticMarkup(createElement(WeComIdentityCard, {
      linked: false,
      automaticBotCount: 0,
      busy: false,
      onDisconnect: () => undefined,
    }));

    expect(html).toContain("尚未获得企业微信身份");
    expect(html).toContain("请从企业微信应用首页进入后完成身份认证");
    expect(html).toContain("disabled");
    expect(html).not.toContain('href="/auth/wework"');
  });
});
