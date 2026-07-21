import { NextResponse } from "next/server";

import type { ConnectorAuthType } from "@/lib/control-plane/connectors";
import { deleteConnectorConnection, OpenConnectorError, saveConnectorConnection } from "@/lib/server/open-connector";
import { openConnectorErrorResponse, readJsonRecord, readStringRecord } from "@/lib/server/open-connector-route";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const authTypes = new Set<ConnectorAuthType>(["no_auth", "api_key", "custom_credential", "oauth2"]);

export async function PUT(request: Request, context: { params: Promise<{ service: string }> }) {
  try {
    const [{ service }, body] = await Promise.all([context.params, readJsonRecord(request)]);
    const connectionName = typeof body.connectionName === "string" ? body.connectionName.trim() : "";
    const authType = typeof body.authType === "string" && authTypes.has(body.authType as ConnectorAuthType)
      ? body.authType as ConnectorAuthType
      : undefined;
    if (!connectionName || connectionName.length > 128) throw new OpenConnectorError("连接名称不能为空且不能超过 128 个字符", 400);
    if (!authType || authType === "oauth2") throw new OpenConnectorError("请选择有效的非 OAuth 连接方式", 400);
    const connection = await saveConnectorConnection(service, {
      connectionName,
      authType,
      values: readStringRecord(body.values, "values"),
    });
    if (!connection) throw new OpenConnectorError("OpenConnector 返回了无效的连接数据");
    return NextResponse.json({ connection, message: "连接已保存" });
  } catch (error) {
    return openConnectorErrorResponse(error);
  }
}
export async function DELETE(request: Request, context: { params: Promise<{ service: string }> }) {
  try {
    const [{ service }, body] = await Promise.all([context.params, readJsonRecord(request)]);
    const connectionName = typeof body.connectionName === "string" ? body.connectionName.trim() : "";
    if (!connectionName) throw new OpenConnectorError("连接名称不能为空", 400);
    await deleteConnectorConnection(service, connectionName);
    return NextResponse.json({ message: "连接已断开" });
  } catch (error) {
    return openConnectorErrorResponse(error);
  }
}
