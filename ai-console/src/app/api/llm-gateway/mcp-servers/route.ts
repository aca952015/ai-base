import { NextResponse } from "next/server";

import {
  getSystemManagedMcpServer,
  isSystemManagedMcpServerId,
  readGatewayMcpServers,
  saveGatewayMcpServers,
  testGatewayMcpServer,
  validateGatewayMcpServersInput,
} from "@/lib/server/gateway-config";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET() {
  return NextResponse.json(await readGatewayMcpServers());
}

export async function PUT(request: Request) {
  let body: unknown;
  try {
    body = await request.json();
  } catch {
    return NextResponse.json({ error: "invalid JSON body" }, { status: 400 });
  }

  const validation = validateGatewayMcpServersInput(body);
  if (!validation.ok) {
    return NextResponse.json(
      { error: "invalid MCP servers", details: validation.errors },
      { status: 400 },
    );
  }
  try {
    return NextResponse.json({
      ...(await saveGatewayMcpServers(validation.value)),
      message: "MCP 配置已保存，Envoy AI 正在自动重载",
    });
  } catch (error) {
    return NextResponse.json(
      { error: error instanceof Error ? error.message : "failed to save MCP servers" },
      { status: 400 },
    );
  }
}

export async function POST(request: Request) {
  let body: unknown;
  try {
    body = await request.json();
  } catch {
    return NextResponse.json({ error: "invalid JSON body" }, { status: 400 });
  }
  const server = typeof body === "object" && body !== null
    ? (body as { server?: unknown }).server
    : undefined;
  const serverId = typeof server === "object" && server !== null && !Array.isArray(server)
    ? (server as { id?: unknown }).id
    : undefined;
  if (isSystemManagedMcpServerId(serverId)) {
    return NextResponse.json(await testGatewayMcpServer(getSystemManagedMcpServer(serverId)));
  }
  const testableServer = typeof server === "object" && server !== null && !Array.isArray(server)
    ? { ...server, enabled: false }
    : server;
  const validation = validateGatewayMcpServersInput({ servers: [testableServer] });
  if (!validation.ok || validation.value.length !== 1) {
    return NextResponse.json(
      { error: "invalid MCP server", details: validation.ok ? [] : validation.errors },
      { status: 400 },
    );
  }
  return NextResponse.json(await testGatewayMcpServer(validation.value[0]));
}
