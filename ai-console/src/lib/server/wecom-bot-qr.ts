import { createHash, randomUUID } from "node:crypto";

const WECOM_QR_SOURCE = "ai_base_external";
const WECOM_QR_GENERATE_URL = "https://work.weixin.qq.com/ai/qc/generate";
const WECOM_QR_QUERY_URL = "https://work.weixin.qq.com/ai/qc/query_result";
const WECOM_QR_PAGE_URL = "https://work.weixin.qq.com/ai/qc/gen";
const WECOM_QR_BOOTSTRAP_URL = "https://qyapi.weixin.qq.com/cgi-bin/aibot/cli/get_cli_config";
const WECOM_QR_TIMEOUT_MS = 5 * 60 * 1_000;
const WECOM_QR_REQUEST_TIMEOUT_MS = 10_000;
const WECOM_QR_CODE_PATTERN = /^[A-Za-z0-9_-]{8,128}$/;
const WECOM_QR_DIAGNOSTIC_MAX_DEPTH = 5;
const WECOM_QR_DIAGNOSTIC_SENSITIVE_KEY = /(secret|token|credential|scode|auth_url|bot_?id)/i;
const WECOM_QR_DIAGNOSTIC_NAME_KEY = /(name|title|label|alias)/i;

export class WeComBotQrError extends Error {
  readonly status: number;

  constructor(message: string, status = 502) {
    super(message);
    this.name = "WeComBotQrError";
    this.status = status;
  }
}

export type WeComBotQrSession = {
  scode: string;
  pageUrl: string;
  expiresAt: string;
};

export type WeComBotQrPollResult =
  | { status: "pending" }
  | { status: "connected"; botId: string; secret: string; botName?: string };

function recordValue(value: unknown): Record<string, unknown> | undefined {
  return value && typeof value === "object" && !Array.isArray(value)
    ? value as Record<string, unknown>
    : undefined;
}

function requiredString(value: unknown) {
  return typeof value === "string" && value.trim() ? value.trim() : undefined;
}

function diagnosticValue(value: unknown, key = "", depth = 0): unknown {
  if (WECOM_QR_DIAGNOSTIC_SENSITIVE_KEY.test(key)) return "[redacted]";
  if (depth >= WECOM_QR_DIAGNOSTIC_MAX_DEPTH) return "[max-depth]";
  if (value === null || typeof value === "boolean" || typeof value === "number") return value;
  if (typeof value === "string") {
    if (WECOM_QR_DIAGNOSTIC_NAME_KEY.test(key)) return Array.from(value).slice(0, 120).join("");
    return `[string:${Array.from(value).length}]`;
  }
  if (Array.isArray(value)) {
    return value.slice(0, 10).map((item) => diagnosticValue(item, key, depth + 1));
  }
  const record = recordValue(value);
  if (!record) return `[${typeof value}]`;
  return Object.fromEntries(
    Object.keys(record)
      .sort()
      .map((childKey) => [childKey, diagnosticValue(record[childKey], childKey, depth + 1)]),
  );
}

function logWeComQrDiagnostic(stage: string, payload: unknown) {
  console.info("[wecom-bot-qr]", JSON.stringify({
    event: "wecom_bot_qr_diagnostic",
    stage,
    payload: diagnosticValue(payload),
  }));
}

function assertTrustedWeComUrl(value: unknown, label: string) {
  const text = requiredString(value);
  if (!text) throw new WeComBotQrError(`${label}响应格式无效`);
  let url: URL;
  try {
    url = new URL(text);
  } catch {
    throw new WeComBotQrError(`${label}响应格式无效`);
  }
  if (url.protocol !== "https:" || url.hostname !== "work.weixin.qq.com") {
    throw new WeComBotQrError(`${label}返回了不可信地址`);
  }
  return url;
}

async function fetchWeComQrJson(url: URL, fetcher: typeof fetch, init?: RequestInit) {
  let response: Response;
  try {
    response = await fetcher(url, {
      ...init,
      cache: "no-store",
      signal: AbortSignal.timeout(WECOM_QR_REQUEST_TIMEOUT_MS),
    });
  } catch {
    throw new WeComBotQrError("企业微信机器人扫码服务暂时不可用");
  }
  const payload = await response.json().catch(() => undefined) as unknown;
  if (!response.ok) throw new WeComBotQrError("企业微信机器人扫码服务请求失败");
  return recordValue(payload);
}

export async function createWeComBotQrSession(
  fetcher: typeof fetch = fetch,
  now = Date.now(),
): Promise<WeComBotQrSession> {
  const generateUrl = new URL(WECOM_QR_GENERATE_URL);
  generateUrl.searchParams.set("source", WECOM_QR_SOURCE);
  generateUrl.searchParams.set("plat", "3");
  const payload = await fetchWeComQrJson(generateUrl, fetcher);
  const data = recordValue(payload?.data);
  const scode = requiredString(data?.scode);
  if (!scode || !WECOM_QR_CODE_PATTERN.test(scode)) {
    throw new WeComBotQrError("企业微信机器人扫码会话格式无效");
  }
  assertTrustedWeComUrl(data?.auth_url, "企业微信机器人扫码");
  const pageUrl = new URL(WECOM_QR_PAGE_URL);
  pageUrl.searchParams.set("source", WECOM_QR_SOURCE);
  pageUrl.searchParams.set("scode", scode);
  return {
    scode,
    pageUrl: pageUrl.toString(),
    expiresAt: new Date(now + WECOM_QR_TIMEOUT_MS).toISOString(),
  };
}

export async function pollWeComBotQrSession(
  scode: string,
  fetcher: typeof fetch = fetch,
): Promise<WeComBotQrPollResult> {
  if (!WECOM_QR_CODE_PATTERN.test(scode)) {
    throw new WeComBotQrError("企业微信机器人扫码会话无效", 400);
  }
  const queryUrl = new URL(WECOM_QR_QUERY_URL);
  queryUrl.searchParams.set("scode", scode);
  const payload = await fetchWeComQrJson(queryUrl, fetcher);
  const data = recordValue(payload?.data);
  if (data?.status !== "success") return { status: "pending" };
  logWeComQrDiagnostic("query_result.success", payload);
  const botInfo = recordValue(data.bot_info);
  const botId = requiredString(botInfo?.botid);
  const secret = requiredString(botInfo?.secret);
  const botName = requiredString(botInfo?.name)
    || requiredString(botInfo?.bot_name)
    || requiredString(botInfo?.botname);
  if (!botId || !secret) {
    throw new WeComBotQrError("扫码成功，但企业微信未返回完整机器人凭据");
  }
  if (botName && Array.from(botName).length > 120) {
    throw new WeComBotQrError("扫码成功，但企业微信返回的机器人名称无效");
  }
  return {
    status: "connected",
    botId,
    secret,
    ...(botName ? { botName } : {}),
  };
}

export async function bootstrapWeComBotQrCredential(
  botId: string,
  secret: string,
  fetcher: typeof fetch = fetch,
  now = Date.now(),
) {
  const normalizedBotId = requiredString(botId);
  const normalizedSecret = requiredString(secret);
  if (!normalizedBotId || !normalizedSecret) {
    throw new WeComBotQrError("企业微信机器人扫码凭据不完整", 400);
  }
  const time = Math.floor(now / 1_000);
  const nonce = `cli_${now}_${randomUUID().replaceAll("-", "").slice(0, 8)}`;
  const signature = createHash("sha256")
    .update(`${normalizedSecret}${normalizedBotId}${time}${nonce}`)
    .digest("hex");
  const payload = await fetchWeComQrJson(new URL(WECOM_QR_BOOTSTRAP_URL), fetcher, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      bot_id: normalizedBotId,
      time,
      nonce,
      signature,
      bind_source: 2,
    }),
  });
  logWeComQrDiagnostic("get_cli_config.response", payload);
  const errcode = typeof payload?.errcode === "number" ? payload.errcode : 0;
  if (errcode !== 0 || !requiredString(payload?.token)) {
    throw new WeComBotQrError("企业微信机器人扫码凭据验证失败");
  }
}
