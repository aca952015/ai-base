import { describe, expect, it, vi } from "vitest";

import {
  bootstrapWeComBotQrCredential,
  createWeComBotQrSession,
  pollWeComBotQrSession,
} from "./wecom-bot-qr";

describe("WeCom bot QR authorization", () => {
  it("creates a short-lived trusted WeCom QR page without exposing the scan code separately", async () => {
    const fetcher = vi.fn().mockResolvedValue(new Response(JSON.stringify({
      data: {
        scode: "AbCdEf1234567890",
        auth_url: "https://work.weixin.qq.com/ai/qc/auth?ticket=trusted",
      },
    }), { status: 200 }));

    const session = await createWeComBotQrSession(fetcher, Date.parse("2026-08-19T00:00:00.000Z"));

    expect(fetcher.mock.calls[0][0].toString()).toContain("source=ai_base_external");
    expect(session).toEqual({
      scode: "AbCdEf1234567890",
      pageUrl: "https://work.weixin.qq.com/ai/qc/gen?source=ai_base_external&scode=AbCdEf1234567890",
      expiresAt: "2026-08-19T00:05:00.000Z",
    });
  });

  it("rejects a QR payload that points outside the trusted WeCom host", async () => {
    const fetcher = vi.fn().mockResolvedValue(new Response(JSON.stringify({
      data: {
        scode: "AbCdEf1234567890",
        auth_url: "https://attacker.example.com/scan",
      },
    }), { status: 200 }));

    await expect(createWeComBotQrSession(fetcher)).rejects.toThrow("不可信地址");
  });

  it("keeps credentials on the server-side result and distinguishes pending scans", async () => {
    const log = vi.spyOn(console, "info").mockImplementation(() => undefined);
    const pendingFetcher = vi.fn().mockResolvedValue(new Response(JSON.stringify({
      data: { status: "init" },
    }), { status: 200 }));
    const connectedFetcher = vi.fn().mockResolvedValue(new Response(JSON.stringify({
      data: {
        status: "success",
        bot_info: { botid: "bot-private", secret: "secret-private", name: "项目助手机器人" },
      },
    }), { status: 200 }));

    await expect(pollWeComBotQrSession("AbCdEf1234567890", pendingFetcher)).resolves.toEqual({ status: "pending" });
    await expect(pollWeComBotQrSession("AbCdEf1234567890", connectedFetcher)).resolves.toEqual({
      status: "connected",
      botId: "bot-private",
      secret: "secret-private",
      botName: "项目助手机器人",
    });
    const diagnostic = log.mock.calls.flat().join(" ");
    expect(diagnostic).toContain("query_result.success");
    expect(diagnostic).toContain("项目助手机器人");
    expect(diagnostic).not.toContain("bot-private");
    expect(diagnostic).not.toContain("secret-private");
    log.mockRestore();
  });

  it("accepts the callback bot_name field used by compatible WeCom responses", async () => {
    const fetcher = vi.fn().mockResolvedValue(new Response(JSON.stringify({
      data: {
        status: "success",
        bot_info: { botid: "bot-private", secret: "secret-private", bot_name: "交付机器人" },
      },
    }), { status: 200 }));

    await expect(pollWeComBotQrSession("AbCdEf1234567890", fetcher)).resolves.toMatchObject({
      status: "connected",
      botName: "交付机器人",
    });
  });

  it("bootstraps QR credentials through the official QR bind source without returning the token", async () => {
    const log = vi.spyOn(console, "info").mockImplementation(() => undefined);
    const fetcher = vi.fn().mockResolvedValue(new Response(JSON.stringify({
      errcode: 0,
      errmsg: "ok",
      token: "server-only-token",
      robot_title: "项目助手机器人",
    }), { status: 200 }));

    await expect(bootstrapWeComBotQrCredential(
      "bot-private",
      "secret-private",
      fetcher,
      Date.parse("2026-08-19T00:00:00.000Z"),
    )).resolves.toBeUndefined();

    expect(fetcher).toHaveBeenCalledOnce();
    expect(fetcher.mock.calls[0][0].toString()).toBe(
      "https://qyapi.weixin.qq.com/cgi-bin/aibot/cli/get_cli_config",
    );
    const body = JSON.parse(String(fetcher.mock.calls[0][1]?.body));
    expect(body).toMatchObject({
      bot_id: "bot-private",
      bind_source: 2,
      time: Date.parse("2026-08-19T00:00:00.000Z") / 1_000,
    });
    expect(body.nonce).toMatch(/^cli_\d+_[a-f0-9]{8}$/);
    expect(body.signature).toMatch(/^[a-f0-9]{64}$/);
    const diagnostic = log.mock.calls.flat().join(" ");
    expect(diagnostic).toContain("get_cli_config.response");
    expect(diagnostic).toContain("项目助手机器人");
    expect(diagnostic).not.toContain("server-only-token");
    log.mockRestore();
  });

  it("rejects a QR credential bootstrap that does not return an access token", async () => {
    const fetcher = vi.fn().mockResolvedValue(new Response(JSON.stringify({
      errcode: 0,
      errmsg: "ok",
    }), { status: 200 }));

    await expect(bootstrapWeComBotQrCredential("bot-private", "secret-private", fetcher))
      .rejects.toThrow("扫码凭据验证失败");
  });
});
