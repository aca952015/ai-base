import { NextResponse } from "next/server";

import { ConsoleAuthError, requireConsoleAdmin } from "@/lib/server/console-identity";
import {
  activateIntegrationApplication,
  IntegrationStoreError,
} from "@/lib/server/integrations";
import { OpenConnectorError } from "@/lib/server/open-connector";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function POST(_request: Request, context: { params: Promise<{ id: string }> }) {
  try {
    await requireConsoleAdmin();
    const { id } = await context.params;
    return NextResponse.json(await activateIntegrationApplication(id));
  } catch (error) {
    const known = error instanceof IntegrationStoreError
      || error instanceof ConsoleAuthError
      || error instanceof OpenConnectorError;
    if (!known) console.error("Integration activation failed", error);
    return NextResponse.json({
      error: known ? error.message : "应用启用失败",
    }, { status: known ? error.status : 500 });
  }
}
