import { NextResponse } from "next/server";

import {
  readGatewayChannels,
  saveGatewayChannels,
  testGatewayChannel,
  validateGatewayChannelsInput,
} from "@/lib/server/gateway-config";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET() {
  return NextResponse.json(await readGatewayChannels());
}

export async function PUT(request: Request) {
  let body: unknown;
  try {
    body = await request.json();
  } catch {
    return NextResponse.json({ error: "invalid JSON body" }, { status: 400 });
  }

  const validation = validateGatewayChannelsInput(body);
  if (!validation.ok) {
    return NextResponse.json(
      { error: "invalid gateway channels", details: validation.errors },
      { status: 400 },
    );
  }
  try {
    return NextResponse.json({
      ...(await saveGatewayChannels(validation.value)),
      message: "渠道配置已保存，网关正在自动重载",
    });
  } catch (error) {
    return NextResponse.json(
      { error: error instanceof Error ? error.message : "failed to save gateway channels" },
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

  const channel = typeof body === "object" && body !== null
    ? (body as { channel?: unknown }).channel
    : undefined;
  const testableChannel = typeof channel === "object" && channel !== null && !Array.isArray(channel)
    ? { ...channel, enabled: false }
    : channel;
  const validation = validateGatewayChannelsInput({ channels: [testableChannel] });
  if (!validation.ok || validation.value.length !== 1) {
    return NextResponse.json(
      { error: "invalid gateway channel", details: validation.ok ? [] : validation.errors },
      { status: 400 },
    );
  }
  return NextResponse.json(await testGatewayChannel(validation.value[0]));
}
