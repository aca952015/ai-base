import { NextResponse } from "next/server";

import {
  deleteIntegrationApplication,
  IntegrationStoreError,
  updateIntegrationApplication,
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

export async function PUT(request: Request, context: { params: Promise<{ id: string }> }) {
  try {
    await requireConsoleAdmin();
    const [{ id }, body] = await Promise.all([
      context.params,
      requestBody(request),
    ]);
    return NextResponse.json(await updateIntegrationApplication(id, {
      name: body.name,
      appId: body.appId,
      note: body.note,
      appSecret: body.appSecret,
      actionIds: body.actionIds,
    }));
  } catch (error) {
    return errorResponse(error);
  }
}

export async function DELETE(_request: Request, context: { params: Promise<{ id: string }> }) {
  try {
    await requireConsoleAdmin();
    const { id } = await context.params;
    return NextResponse.json(await deleteIntegrationApplication(id));
  } catch (error) {
    return errorResponse(error);
  }
}
