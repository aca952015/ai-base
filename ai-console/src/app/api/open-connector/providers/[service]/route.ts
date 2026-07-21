import { NextResponse } from "next/server";

import { getConnectorProvider } from "@/lib/server/open-connector";
import { openConnectorErrorResponse } from "@/lib/server/open-connector-route";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET(_request: Request, context: { params: Promise<{ service: string }> }) {
  try {
    const { service } = await context.params;
    return NextResponse.json(await getConnectorProvider(service));
  } catch (error) {
    return openConnectorErrorResponse(error);
  }
}
