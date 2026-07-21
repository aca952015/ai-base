import { NextResponse } from "next/server";

import { listConnectorProviders } from "@/lib/server/open-connector";
import { openConnectorErrorResponse } from "@/lib/server/open-connector-route";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET(request: Request) {
  const url = new URL(request.url);
  try {
    return NextResponse.json(await listConnectorProviders({
      query: url.searchParams.get("query") || undefined,
      category: url.searchParams.get("category") || undefined,
      authType: url.searchParams.get("authType") || undefined,
      page: Number(url.searchParams.get("page") || 1),
      limit: Number(url.searchParams.get("limit") || 24),
    }));
  } catch (error) {
    return openConnectorErrorResponse(error);
  }
}
