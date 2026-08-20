import { NextResponse } from "next/server";

import { readConfig } from "@/lib/server/config";
import { readGatewayMcpServers } from "@/lib/server/gateway-config";
import { checkServices } from "@/lib/server/services";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET() {
  await readGatewayMcpServers();
  return NextResponse.json(await checkServices(await readConfig()));
}
