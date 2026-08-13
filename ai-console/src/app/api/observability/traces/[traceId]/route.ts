import { NextResponse } from "next/server";

import { ConsoleAuthError, requireConsoleAdmin } from "@/lib/server/console-identity";
import { getObservabilityTrace, ObservabilityRequestError } from "@/lib/server/observability";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET(_request: Request, context: { params: Promise<{ traceId: string }> }) {
  try {
    await requireConsoleAdmin();
    const { traceId } = await context.params;
    const trace = await getObservabilityTrace(traceId);
    return trace
      ? NextResponse.json(trace)
      : NextResponse.json({ error: "Trace 不存在或没有可安全展示的 Span" }, { status: 404 });
  } catch (error) {
    const known = error instanceof ConsoleAuthError || error instanceof ObservabilityRequestError;
    return NextResponse.json({ error: known ? error.message : "Trace 查询失败" }, { status: known ? error.status : 503 });
  }
}
