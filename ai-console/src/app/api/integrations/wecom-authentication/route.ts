import { NextResponse } from "next/server";

import { ConsoleAuthError, requireConsoleAdmin } from "@/lib/server/console-identity";
import { IntegrationStoreError } from "@/lib/server/integrations";
import {
  createWeComAuthenticationConfiguration,
  deleteWeComAuthenticationConfiguration,
  getWeComAuthenticationConfiguration,
  updateWeComAuthenticationConfiguration,
  validateWeComAuthenticationSettings,
} from "@/lib/server/wecom-authentication";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

function errorResponse(error: unknown, fallback: string) {
  const known = error instanceof ConsoleAuthError || error instanceof IntegrationStoreError;
  return NextResponse.json(
    { error: known ? error.message : fallback },
    { status: known ? error.status : 503 },
  );
}

export async function GET() {
  try {
    await requireConsoleAdmin();
    return NextResponse.json(await getWeComAuthenticationConfiguration());
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
    return NextResponse.json(await updateWeComAuthenticationConfiguration(validation.value));
  } catch (error) {
    return errorResponse(error, "保存企业微信认证配置失败");
  }
}

export async function POST(request: Request) {
  try {
    await requireConsoleAdmin();
  } catch (error) {
    return errorResponse(error, "无权新增企业微信认证组织");
  }
  const body = await request.json().catch(() => undefined);
  const validation = validateWeComAuthenticationSettings(body);
  if (!validation.ok) {
    return NextResponse.json(
      { error: "invalid WeCom authentication settings", details: validation.errors },
      { status: 400 },
    );
  }
  try {
    return NextResponse.json(await createWeComAuthenticationConfiguration(validation.value), { status: 201 });
  } catch (error) {
    return errorResponse(error, "新增企业微信认证组织失败");
  }
}

export async function DELETE(request: Request) {
  try {
    await requireConsoleAdmin();
    const id = new URL(request.url).searchParams.get("id") || "";
    return NextResponse.json(await deleteWeComAuthenticationConfiguration(id));
  } catch (error) {
    return errorResponse(error, "删除企业微信认证组织失败");
  }
}
