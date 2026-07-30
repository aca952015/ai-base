import { NextResponse } from "next/server";

import {
  applyLightRagConfig,
  readLightRagConfig,
  validateLightRagConfigInput,
} from "@/lib/server/lightrag-config";
import { ConsoleAuthError, requireConsoleAdmin } from "@/lib/server/console-identity";

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
    return NextResponse.json(await readLightRagConfig());
  } catch (error) {
    return errorResponse(error, "读取 LightRAG 配置失败");
  }
}

export async function PUT(request: Request) {
  try {
    await requireConsoleAdmin();
  } catch (error) {
    return errorResponse(error, "无权应用 LightRAG 配置");
  }
  let body: unknown;
  try {
    body = await request.json();
  } catch {
    return NextResponse.json({ error: "invalid JSON body" }, { status: 400 });
  }
  const validation = validateLightRagConfigInput(body);
  if (!validation.ok) {
    return NextResponse.json(
      { error: "invalid LightRAG config", details: validation.errors },
      { status: 400 },
    );
  }
  try {
    return NextResponse.json(await applyLightRagConfig(validation.value));
  } catch (error) {
    return errorResponse(error, "应用 LightRAG 配置失败");
  }
}
