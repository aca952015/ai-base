import { NextResponse } from "next/server";

import { getConnectorOAuthConfig, OpenConnectorError, saveConnectorOAuthConfig } from "@/lib/server/open-connector";
import { openConnectorErrorResponse, readJsonRecord, readStringRecord } from "@/lib/server/open-connector-route";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET(_request: Request, context: { params: Promise<{ service: string }> }) {
  try {
    const { service } = await context.params;
    return NextResponse.json(await getConnectorOAuthConfig(service));
  } catch (error) {
    return openConnectorErrorResponse(error);
  }
}
export async function PUT(request: Request, context: { params: Promise<{ service: string }> }) {
  try {
    const [{ service }, body] = await Promise.all([context.params, readJsonRecord(request)]);
    const clientId = typeof body.clientId === "string" ? body.clientId.trim() : "";
    const clientSecret = typeof body.clientSecret === "string" ? body.clientSecret.trim() : "";
    if (!clientId) throw new OpenConnectorError("Client ID 不能为空", 400);
    return NextResponse.json(await saveConnectorOAuthConfig(service, {
      clientId,
      clientSecret,
      extra: readStringRecord(body.extra, "extra"),
      secretExtra: readStringRecord(body.secretExtra, "secretExtra"),
    }));
  } catch (error) {
    return openConnectorErrorResponse(error);
  }
}
