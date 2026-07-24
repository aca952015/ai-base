import { NextResponse } from "next/server";

import { ConsoleAuthError, getConsoleIdentity } from "@/lib/server/console-identity";
import {
  getEmployeeIntegrations,
  IntegrationStoreError,
} from "@/lib/server/integrations";
import { OpenConnectorError } from "@/lib/server/open-connector";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET() {
  try {
    const identity = await getConsoleIdentity();
    return NextResponse.json(await getEmployeeIntegrations(identity));
  } catch (error) {
    const known = error instanceof IntegrationStoreError
      || error instanceof ConsoleAuthError
      || error instanceof OpenConnectorError;
    if (!known) console.error("Employee integration request failed", error);
    return NextResponse.json({
      error: known ? error.message : "账号绑定信息读取失败",
    }, { status: known ? error.status : 500 });
  }
}
