import { NextResponse } from "next/server";

import { ConsoleAuthError, getConsoleIdentity } from "@/lib/server/console-identity";
import {
  IntegrationStoreError,
  pollEmployeeWeComBotAuthorization,
  startEmployeeWeComBotAuthorization,
} from "@/lib/server/integrations";
import { OpenConnectorError } from "@/lib/server/open-connector";
import { WeComBotQrError } from "@/lib/server/wecom-bot-qr";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

function errorResponse(error: unknown) {
  const known = error instanceof IntegrationStoreError
    || error instanceof ConsoleAuthError
    || error instanceof OpenConnectorError
    || error instanceof WeComBotQrError;
  if (!known) console.error("Employee WeCom bot authorization failed", error);
  const message = error instanceof OpenConnectorError
    ? "企业微信机器人连接校验失败"
    : known
      ? error.message
      : "企业微信机器人扫码绑定失败";
  return NextResponse.json({
    error: message,
  }, { status: known ? error.status : 500 });
}

export async function POST() {
  try {
    const identity = await getConsoleIdentity();
    return NextResponse.json(
      await startEmployeeWeComBotAuthorization(identity),
      { status: 201 },
    );
  } catch (error) {
    return errorResponse(error);
  }
}

export async function GET(request: Request) {
  try {
    const [identity, url] = await Promise.all([
      getConsoleIdentity(),
      Promise.resolve(new URL(request.url)),
    ]);
    return NextResponse.json(
      await pollEmployeeWeComBotAuthorization(identity, url.searchParams.get("request") || ""),
    );
  } catch (error) {
    return errorResponse(error);
  }
}
