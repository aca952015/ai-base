import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";

import { WeComAuthSettingsForm } from "./wecom-auth-settings-form";

describe("WeCom authentication organization management", () => {
  it("renders organizations as cards and keeps the editor closed initially", () => {
    const html = renderToStaticMarkup(createElement(WeComAuthSettingsForm, {
      initialSnapshot: {
        organizations: [{
          id: "organization-id",
          organizationName: "示例组织",
          corpId: "ww1234567890",
          relayCallbackUrl: "https://tn1.cofly-ai.cn/callbacks/wecom",
          active: true,
          configured: true,
          applicationHomepageUrl: "https://tn1.cofly-ai.cn/launch/wecom",
          updatedAt: "2026-08-19T00:00:00.000Z",
        }],
        configuredCount: 1,
        updatedAt: "2026-08-19T00:00:00.000Z",
      },
    }));

    expect(html).toContain("integration-application-grid");
    expect(html).toContain("wecom-organization-card");
    expect(html).toContain("示例组织");
    expect(html).toContain("增加认证组织");
    expect(html).not.toContain("organization=organization-id");
    expect(html).not.toContain("settings-subpage-list");
    expect(html).not.toContain('role="dialog"');
  });
});
