import { describe, expect, it } from "vitest";

import {
  resolveWeComCallbackUrl,
  validateWeComAuthenticationSettings,
} from "./wecom-authentication";

describe("WeCom authentication configuration", () => {
  it("normalizes the single administrator-managed relay configuration", () => {
    const validation = validateWeComAuthenticationSettings({
      corpId: " ww-example-corp ",
      appSecret: "secret-value",
      publicBaseUrl: "https://ai.example.com/wecom-oidc/",
      callbackMode: "relay",
      relayCallbackUrl: "https://tn1.cofly-ai.cn/callbacks/wecom",
      emailDomain: "Example.COM",
    });
    expect(validation).toEqual({
      ok: true,
      value: {
        corpId: "ww-example-corp",
        appSecret: "secret-value",
        publicBaseUrl: "https://ai.example.com/wecom-oidc",
        callbackMode: "relay",
        relayCallbackUrl: "https://tn1.cofly-ai.cn/callbacks/wecom",
        emailDomain: "example.com",
      },
    });
    if (!validation.ok) return;
    expect(resolveWeComCallbackUrl(validation.value)).toBe("https://tn1.cofly-ai.cn/callbacks/wecom");
  });

  it("allows an empty secret only for preserving an existing encrypted value", () => {
    const validation = validateWeComAuthenticationSettings({
      corpId: "ww-example-corp",
      appSecret: "",
      publicBaseUrl: "http://127.0.0.1:8080/wecom-oidc",
      callbackMode: "direct",
      emailDomain: "example.com",
    });
    expect(validation).toEqual({
      ok: true,
      value: {
        corpId: "ww-example-corp",
        publicBaseUrl: "http://127.0.0.1:8080/wecom-oidc",
        callbackMode: "direct",
        emailDomain: "example.com",
      },
    });
  });

  it("rejects unsafe callback URLs, invalid domains, and response-only fields", () => {
    const validation = validateWeComAuthenticationSettings({
      corpId: "",
      publicBaseUrl: "https://user:pass@ai.example.com/wecom-oidc",
      callbackMode: "relay",
      relayCallbackUrl: "http://tn1.cofly-ai.cn/callbacks/wecom?target=attacker",
      emailDomain: "https://example.com",
      secretConfigured: true,
    });
    expect(validation.ok).toBe(false);
    if (validation.ok) return;
    expect(validation.errors).toEqual(expect.arrayContaining([
      "unsupported field: secretConfigured",
      "企业 ID（CorpID）不能为空",
      "AI Base 公开认证入口必须是绝对 HTTP(S) 地址，且不能包含账号、查询参数或片段",
      "公网中继回调地址必须是绝对 HTTP(S) 地址，且不能包含账号、查询参数或片段",
      "企业邮箱域必须是有效的 DNS 域名",
    ]));
  });
});
