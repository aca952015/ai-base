import { NextResponse } from "next/server";

import { ConsoleAuthError, requireConsoleAdmin } from "@/lib/server/console-identity";
import {
  getWeComAuthenticationSnapshot,
  readConfig,
  updateWeComAuthenticationSettings,
  validateWeComAuthenticationSettings,
} from "@/lib/server/config";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

function errorResponse(error: unknown, fallback: string) {
  const status = error instanceof ConsoleAuthError ? error.status : 503;
  return NextResponse.json(
    { error: error instanceof Error ? error.message : fallback },
    { status },
  );
}

export async function GET() {
  try {
    await requireConsoleAdmin();
    return NextResponse.json(getWeComAuthenticationSnapshot(await readConfig()));
  } catch (error) {
    return errorResponse(error, "读取企业微信认证配置失败");
  }
}

export async function PUT(request: Request) {
  try {
    await requireConsoleAdmin();
  } catch (error) {
    return errorResponse(error, "无权修改企业微信认证配置");
  }
  let body: unknown;
  try {
    body = await request.json();
  } catch {
    return NextResponse.json({ error: "invalid JSON body" }, { status: 400 });
  }
  const validation = validateWeComAuthenticationSettings(body);
  if (!validation.ok) {
    return NextResponse.json(
      { error: "invalid WeCom authentication settings", details: validation.errors },
      { status: 400 },
    );
  }
  try {
    return NextResponse.json(await updateWeComAuthenticationSettings(validation.value));
  } catch (error) {
    return errorResponse(error, "保存企业微信认证配置失败");
  }
}
