import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import {
  consumeWeComRelayIdentity,
  createWeComRelayResultConsumerProof,
  openWeComRelayPayload,
  readWeComRelayResultHandoff,
  sealWeComRelayPayload,
  WeComRelayError,
} from "./wecom-relay";

const originalSharedKey = process.env.WECOM_RELAY_SHARED_KEY;
const sharedKey = Buffer.from("0123456789abcdef0123456789abcdef").toString("base64url");

beforeEach(() => {
  process.env.WECOM_RELAY_SHARED_KEY = sharedKey;
});

afterEach(() => {
  vi.restoreAllMocks();
  if (originalSharedKey === undefined) delete process.env.WECOM_RELAY_SHARED_KEY;
  else process.env.WECOM_RELAY_SHARED_KEY = originalSharedKey;
});

describe("WeCom relay result protocol", () => {
  it("matches the Relay result-consumer proof vector", () => {
    expect(createWeComRelayResultConsumerProof("v1.example-ticket")).toBe(
      "r1mb5mR4HpJqJINDBm96bqAgV1kn5hLZI7oNyf2S15E",
    );
  });

  it("authenticates encrypted tickets and rejects tampering", () => {
    const sealed = sealWeComRelayPayload({ value: "sensitive" }, Buffer.alloc(12, 1));
    expect(openWeComRelayPayload(sealed)).toEqual({ value: "sensitive" });
    const parts = sealed.split(".");
    parts[2] = `${parts[2][0] === "A" ? "B" : "A"}${parts[2].slice(1)}`;
    expect(() => openWeComRelayPayload(parts.join("."))).toThrow(WeComRelayError);
  });

  it("opens the Relay Go ticket vector", () => {
    const ticket = "v1.AQEBAQEBAQEBAQEB.RTa7HAVXRSTX5wxXPnhfENdBIR-Y1teCwFaaV-XuJuQtU5VR71Yktr9Y09uEg2usJNI6dDT41PKCiTirE162foqAsg_W3exhcByscSDWekdOnjL-xjlt_vvQ89bGPJDYXdrtREG2lIzwS2aMdAvtbqzEjqQPpYifHakI1iiJDXrt7U8Xzlh_i3mudQT6djXQJX_O0OxegkeDk1LEj_hgG9ycrOmNBDIue3fyOEYNOViV2hgN0Ln3ThNfQClRHvI";
    expect(openWeComRelayPayload(ticket)).toEqual({
      v: 1,
      result_id: "r".repeat(43),
      relay_callback_url: "https://tn2.cofly-ai.cn/callbacks/wecom",
      issued_at: 1_800_000_000,
      expires_at: 1_800_000_300,
    });
  });

  it("maps a short-lived path ticket to its fixed Relay callback", () => {
    const now = 1_800_000_000;
    const ticket = sealWeComRelayPayload({
      v: 1,
      result_id: "r".repeat(43),
      relay_callback_url: "https://tn2.cofly-ai.cn/callbacks/wecom",
      issued_at: now,
      expires_at: now + 300,
    });
    expect(readWeComRelayResultHandoff(ticket, now)).toEqual({
      relayCallbackUrl: "https://tn2.cofly-ai.cn/callbacks/wecom",
    });
    expect(() => readWeComRelayResultHandoff(ticket, now + 301)).toThrow("已过期");
  });

  it("consumes the opaque result from the authenticated Relay endpoint", async () => {
    const now = Math.floor(Date.now() / 1_000);
    const ticket = sealWeComRelayPayload({
      v: 1,
      result_id: "r".repeat(43),
      relay_callback_url: "https://tn2.cofly-ai.cn/callbacks/wecom",
      issued_at: now,
      expires_at: now + 300,
    });
    const fetchMock = vi.spyOn(globalThis, "fetch").mockResolvedValue(Response.json({
      corp_id: "ww-example",
      user_id: "ZhangSan",
      error: "",
    }));

    await expect(consumeWeComRelayIdentity(ticket)).resolves.toEqual({
      corpId: "ww-example",
      userId: "ZhangSan",
      relayIssuer: "https://tn2.cofly-ai.cn/wecom",
    });
    expect(fetchMock).toHaveBeenCalledWith(
      new URL("https://tn2.cofly-ai.cn/api/wecom/results"),
      expect.objectContaining({
        method: "POST",
        body: JSON.stringify({ ticket }),
        headers: expect.objectContaining({
          "X-AI-Base-Relay-Proof": createWeComRelayResultConsumerProof(ticket),
        }),
      }),
    );
  });

  it("rejects a non-HTTPS Relay callback", () => {
    const now = 1_800_000_000;
    const ticket = sealWeComRelayPayload({
      v: 1,
      result_id: "r".repeat(43),
      relay_callback_url: "http://tn2.cofly-ai.cn/callbacks/wecom",
      issued_at: now,
      expires_at: now + 300,
    });
    expect(() => readWeComRelayResultHandoff(ticket, now)).toThrow("地址无效");
  });

  it("maps denial, exchange failure, expiry and replay rejection", async () => {
    const now = Math.floor(Date.now() / 1_000);
    const ticket = sealWeComRelayPayload({
      v: 1,
      result_id: "r".repeat(43),
      relay_callback_url: "https://tn2.cofly-ai.cn/callbacks/wecom",
      issued_at: now,
      expires_at: now + 300,
    });
    vi.spyOn(globalThis, "fetch").mockResolvedValueOnce(Response.json({
      corp_id: "",
      user_id: "",
      error: "access_denied",
    }));
    await expect(consumeWeComRelayIdentity(ticket)).rejects.toThrow("用户取消");

    vi.mocked(fetch).mockResolvedValueOnce(Response.json({
      corp_id: "",
      user_id: "",
      error: "identity_exchange_failed",
    }));
    await expect(consumeWeComRelayIdentity(ticket)).rejects.toThrow("未能获取员工身份");

    vi.mocked(fetch).mockResolvedValueOnce(Response.json(
      { error: "result_expired_or_consumed" },
      { status: 410 },
    ));
    await expect(consumeWeComRelayIdentity(ticket)).rejects.toThrow("已失效或已被消费");
  });
});
