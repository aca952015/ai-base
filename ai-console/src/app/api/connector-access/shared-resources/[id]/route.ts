import { NextResponse } from "next/server";

import { deleteSharedConnectorResource } from "@/lib/server/connector-access";
import { ConsoleAuthError, requireConsoleAdmin } from "@/lib/server/console-identity";
import { IntegrationStoreError } from "@/lib/server/integrations";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function DELETE(_request: Request, context: { params: Promise<{ id: string }> }) {
  try {
    const identity = await requireConsoleAdmin();
    const { id } = await context.params;
    return NextResponse.json(await deleteSharedConnectorResource(identity, id));
  } catch (error) {
    const known = error instanceof IntegrationStoreError || error instanceof ConsoleAuthError;
    if (!known) console.error("Shared connector access deletion failed", error);
    return NextResponse.json(
      { error: known ? error.message : "受控共享配置删除失败" },
      { status: known ? error.status : 500 },
    );
  }
}
