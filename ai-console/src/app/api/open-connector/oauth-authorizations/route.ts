import { NextResponse } from "next/server";

import { OpenConnectorError, startConnectorOAuthAuthorization } from "@/lib/server/open-connector";
import { openConnectorErrorResponse, readJsonRecord } from "@/lib/server/open-connector-route";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function POST(request: Request) {
  try {
    const body = await readJsonRecord(request);
    const service = typeof body.service === "string" ? body.service.trim() : "";
    const connectionName = typeof body.connectionName === "string" ? body.connectionName.trim() : "";
    if (!service || !connectionName) throw new OpenConnectorError("Connector 和连接名称不能为空", 400);
    return NextResponse.json(await startConnectorOAuthAuthorization(service, connectionName));
  } catch (error) {
    return openConnectorErrorResponse(error);
  }
}
