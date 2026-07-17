import { NextRequest, NextResponse } from "next/server";

import { getComponentData } from "@/lib/server/component-data";
import { readConfig } from "@/lib/server/config";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET(request: NextRequest) {
  const force = request.nextUrl.searchParams.get("refresh") === "1";
  return NextResponse.json(await getComponentData(await readConfig(), { force }));
}
