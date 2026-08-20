import { describe, expect, it } from "vitest";

import { validateWeComAuthenticationSettings } from "./wecom-authentication";

describe("WeCom authentication configuration", () => {
  it("normalizes an administrator-managed organization configuration", () => {
    const validation = validateWeComAuthenticationSettings({
      organizationName: " 示例组织 ",
      corpId: " ww-example-corp ",
      relayCallbackUrl: "https://tn1.cofly-ai.cn/callbacks/wecom",
      active: true,
    });
    expect(validation).toEqual({
      ok: true,
      value: {
        organizationName: "示例组织",
        corpId: "ww-example-corp",
        relayCallbackUrl: "https://tn1.cofly-ai.cn/callbacks/wecom",
        active: true,
      },
    });
  });

  it("keeps the App Secret out of the Console-owned configuration", () => {
    const validation = validateWeComAuthenticationSettings({
      organizationName: "示例组织",
      corpId: "ww-example-corp",
      appSecret: "must-live-on-relay",
      relayCallbackUrl: "https://tn1.cofly-ai.cn/callbacks/wecom",
      active: true,
    });
    expect(validation).toEqual({ ok: false, errors: ["unsupported field: appSecret"] });
  });

  it("accepts the stable default organization UUID created by the migration", () => {
    const validation = validateWeComAuthenticationSettings({
      id: "00000000-0000-0000-0000-000000000001",
      organizationName: "默认组织",
      corpId: "ww-example-corp",
      relayCallbackUrl: "https://tn1.cofly-ai.cn/callbacks/wecom",
      active: true,
    });

    expect(validation).toEqual({
      ok: true,
      value: {
        id: "00000000-0000-0000-0000-000000000001",
        organizationName: "默认组织",
        corpId: "ww-example-corp",
        relayCallbackUrl: "https://tn1.cofly-ai.cn/callbacks/wecom",
        active: true,
      },
    });
  });

  it("rejects unsafe callback URLs, invalid domains, and response-only fields", () => {
    const validation = validateWeComAuthenticationSettings({
      organizationName: "示例组织",
      corpId: "",
      relayCallbackUrl: "https://tn1.cofly-ai.cn/callbacks/wecom?target=attacker",
      secretConfigured: true,
      active: true,
    });
    expect(validation.ok).toBe(false);
    if (validation.ok) return;
    expect(validation.errors).toEqual(expect.arrayContaining([
      "unsupported field: secretConfigured",
      "企业 ID（CorpID）不能为空",
      "公网认证中继回调地址必须是以 /callbacks/wecom 结尾的绝对 HTTPS 地址，且不能包含账号、查询参数或片段",
    ]));
  });

  it("rejects plaintext HTTP Relay callbacks", () => {
    const validation = validateWeComAuthenticationSettings({
      organizationName: "示例组织",
      corpId: "ww-example-corp",
      relayCallbackUrl: "http://tn1.cofly-ai.cn/callbacks/wecom",
      active: true,
    });
    expect(validation.ok).toBe(false);
    if (validation.ok) return;
    expect(validation.errors).toContain(
      "公网认证中继回调地址必须是以 /callbacks/wecom 结尾的绝对 HTTPS 地址，且不能包含账号、查询参数或片段",
    );
  });

  it("still rejects malformed organization IDs", () => {
    const validation = validateWeComAuthenticationSettings({
      id: "not-a-uuid",
      organizationName: "示例组织",
      corpId: "ww-example-corp",
      relayCallbackUrl: "https://tn1.cofly-ai.cn/callbacks/wecom",
      active: true,
    });

    expect(validation.ok).toBe(false);
    if (validation.ok) return;
    expect(validation.errors).toContain("企业微信组织 ID 无效");
  });
});
