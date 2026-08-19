import { NextResponse } from "next/server";

import { ConsoleAuthError, getConsoleIdentity } from "@/lib/server/console-identity";
import {
  disconnectEmployeeWeComBot,
  IntegrationStoreError,
  renameEmployeeWeComBot,
} from "@/lib/server/integrations";
import { OpenConnectorError } from "@/lib/server/open-connector";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

function errorResponse(error: unknown, fallback: string) {
  const known = error instanceof IntegrationStoreError
    || error instanceof ConsoleAuthError
    || error instanceof OpenConnectorError;
  if (!known) console.error(fallback, error);
  return NextResponse.json({
    error: error instanceof OpenConnectorError
      ? fallback
      : known
        ? error.message
        : fallback,
  }, { status: known ? error.status : 500 });
}

export async function PATCH(
  request: Request,
  context: { params: Promise<{ connectionName: string }> },
) {
  try {
    const [identity, { connectionName }, payload] = await Promise.all([
      getConsoleIdentity(),
      context.params,
      request.json().catch(() => undefined),
    ]);
    const displayName = payload && typeof payload === "object" && "displayName" in payload
      ? (payload as { displayName?: unknown }).displayName
      : "";
    return NextResponse.json(await renameEmployeeWeComBot(
      identity,
      connectionName,
      typeof displayName === "string" ? displayName : "",
    ));
  } catch (error) {
    return errorResponse(error, "企业微信机器人连接重命名失败");
  }
}

export async function DELETE(
  _request: Request,
  context: { params: Promise<{ connectionName: string }> },
) {
  try {
    const [identity, { connectionName }] = await Promise.all([
      getConsoleIdentity(),
      context.params,
    ]);
    return NextResponse.json(await disconnectEmployeeWeComBot(identity, connectionName));
  } catch (error) {
    return errorResponse(error, "企业微信机器人连接解绑失败");
  }
}
