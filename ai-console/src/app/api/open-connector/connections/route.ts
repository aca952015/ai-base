import { NextResponse } from "next/server";

import { listConnectorConnections } from "@/lib/server/open-connector";
import { openConnectorErrorResponse } from "@/lib/server/open-connector-route";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET() {
  try {
    return NextResponse.json(await listConnectorConnections());
  } catch (error) {
    return openConnectorErrorResponse(error);
  }
}
