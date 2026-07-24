import { NextResponse } from "next/server";

import {
  createIntegrationApplication,
  getEnterpriseIntegrations,
  IntegrationStoreError,
} from "@/lib/server/integrations";
import { ConsoleAuthError, requireConsoleAdmin } from "@/lib/server/console-identity";
import { OpenConnectorError } from "@/lib/server/open-connector";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

function errorResponse(error: unknown) {
  const known = error instanceof IntegrationStoreError
    || error instanceof ConsoleAuthError
    || error instanceof OpenConnectorError;
  const status = known ? error.status : 500;
  if (!known) console.error("Integration application request failed", error);
  return NextResponse.json({
    error: known ? error.message : "集成应用操作失败",
  }, { status });
}

async function requestBody(request: Request) {
  try {
    const body = await request.json() as unknown;
    if (!body || typeof body !== "object" || Array.isArray(body)) throw new Error();
    return body as Record<string, unknown>;
  } catch {
    throw new IntegrationStoreError("请求体必须是 JSON 对象", 400);
  }
}

export async function GET() {
  try {
    await requireConsoleAdmin();
    return NextResponse.json(await getEnterpriseIntegrations());
  } catch (error) {
    return errorResponse(error);
  }
}

export async function POST(request: Request) {
  try {
    await requireConsoleAdmin();
    const body = await requestBody(request);
    return NextResponse.json(await createIntegrationApplication({
      platform: body.platform,
      name: body.name,
      appId: body.appId,
      note: body.note,
      appSecret: body.appSecret,
      actionIds: body.actionIds,
    }), { status: 201 });
  } catch (error) {
    return errorResponse(error);
  }
}
