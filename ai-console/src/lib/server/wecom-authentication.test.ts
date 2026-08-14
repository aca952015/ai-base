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
      relayCallbackUrl: "https://tn1.cofly-ai.cn/callbacks/wecom",
    });
    expect(validation).toEqual({
      ok: true,
      value: {
        corpId: "ww-example-corp",
        appSecret: "secret-value",
        relayCallbackUrl: "https://tn1.cofly-ai.cn/callbacks/wecom",
      },
    });
    if (!validation.ok) return;
    expect(resolveWeComCallbackUrl(validation.value)).toBe("https://tn1.cofly-ai.cn/callbacks/wecom");
  });

  it("allows an empty secret only for preserving an existing encrypted value", () => {
    const validation = validateWeComAuthenticationSettings({
      corpId: "ww-example-corp",
      appSecret: "",
      relayCallbackUrl: "http://tn1.cofly-ai.cn/callbacks/wecom",
    });
    expect(validation).toEqual({
      ok: true,
      value: {
        corpId: "ww-example-corp",
        relayCallbackUrl: "http://tn1.cofly-ai.cn/callbacks/wecom",
      },
    });
  });

  it("rejects unsafe callback URLs, invalid domains, and response-only fields", () => {
    const validation = validateWeComAuthenticationSettings({
      corpId: "",
      relayCallbackUrl: "http://tn1.cofly-ai.cn/callbacks/wecom?target=attacker",
      secretConfigured: true,
    });
    expect(validation.ok).toBe(false);
    if (validation.ok) return;
    expect(validation.errors).toEqual(expect.arrayContaining([
      "unsupported field: secretConfigured",
      "企业 ID（CorpID）不能为空",
      "公网认证中继回调地址必须是以 /callbacks/wecom 结尾的绝对 HTTP(S) 地址，且不能包含账号、查询参数或片段",
    ]));
  });
});
