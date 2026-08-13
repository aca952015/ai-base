import { NextResponse } from "next/server";

import { ConsoleAuthError, requireConsoleAdmin } from "@/lib/server/console-identity";
import { getObservabilityCalls, ObservabilityRequestError } from "@/lib/server/observability";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET(request: Request) {
  try {
    await requireConsoleAdmin();
    return NextResponse.json(await getObservabilityCalls(new URL(request.url).searchParams));
  } catch (error) {
    const known = error instanceof ConsoleAuthError || error instanceof ObservabilityRequestError;
    return NextResponse.json({ error: known ? error.message : "诊断样本查询失败" }, { status: known ? error.status : 500 });
  }
}
