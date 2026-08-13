import { NextResponse } from "next/server";

import { ConsoleAuthError, requireConsoleAdmin } from "@/lib/server/console-identity";
import { getObservabilitySummary, parseRange } from "@/lib/server/observability";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET(request: Request) {
  try {
    await requireConsoleAdmin();
    return NextResponse.json(await getObservabilitySummary(parseRange(new URL(request.url).searchParams.get("range"))));
  } catch (error) {
    const status = error instanceof ConsoleAuthError ? error.status : 500;
    return NextResponse.json({ error: status === 500 ? "可观测指标查询失败" : error instanceof Error ? error.message : "访问失败" }, { status });
  }
}
