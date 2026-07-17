import { NextResponse } from "next/server";

import { readConfig } from "@/lib/server/config";
import { checkServices } from "@/lib/server/services";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET() {
  return NextResponse.json(await checkServices(await readConfig()));
}
