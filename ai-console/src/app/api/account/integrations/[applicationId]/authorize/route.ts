import { NextResponse } from "next/server";

import { ConsoleAuthError, getConsoleIdentity } from "@/lib/server/console-identity";
import {
  disconnectEmployeeIntegration,
  IntegrationStoreError,
  startEmployeeIntegrationAuthorization,
} from "@/lib/server/integrations";
import { OpenConnectorError } from "@/lib/server/open-connector";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

function errorResponse(error: unknown) {
  const known = error instanceof IntegrationStoreError
    || error instanceof ConsoleAuthError
    || error instanceof OpenConnectorError;
  if (!known) console.error("Employee integration authorization failed", error);
  return NextResponse.json({
    error: known ? error.message : "个人账号绑定操作失败",
  }, { status: known ? error.status : 500 });
}

export async function POST(_request: Request, context: { params: Promise<{ applicationId: string }> }) {
  try {
    const [identity, { applicationId }] = await Promise.all([
      getConsoleIdentity(),
      context.params,
    ]);
    return NextResponse.json(
      await startEmployeeIntegrationAuthorization(identity, applicationId),
      { status: 201 },
    );
  } catch (error) {
    return errorResponse(error);
  }
}

export async function DELETE(_request: Request, context: { params: Promise<{ applicationId: string }> }) {
  try {
    const [identity, { applicationId }] = await Promise.all([
      getConsoleIdentity(),
      context.params,
    ]);
    return NextResponse.json(await disconnectEmployeeIntegration(identity, applicationId));
  } catch (error) {
    return errorResponse(error);
  }
}
