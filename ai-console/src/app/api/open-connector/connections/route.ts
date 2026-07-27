import { NextResponse } from "next/server";

import {
  IntegrationStoreError,
  listClassifiedConnectorConnections,
} from "@/lib/server/integrations";
import { OpenConnectorError } from "@/lib/server/open-connector";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET() {
  try {
    return NextResponse.json(await listClassifiedConnectorConnections());
  } catch (error) {
    const known = error instanceof IntegrationStoreError || error instanceof OpenConnectorError;
    if (!known) console.error("Connector inventory request failed", error);
    return NextResponse.json(
      { error: known ? error.message : "连接器分类信息读取失败" },
      { status: known ? error.status : 500 },
    );
  }
}
