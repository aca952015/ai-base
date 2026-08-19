import { NextResponse } from "next/server";

import { ConsoleAuthError, getConsoleIdentity } from "@/lib/server/console-identity";
import {
  disconnectWeComIdentityLink,
  IntegrationStoreError,
} from "@/lib/server/integrations";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function DELETE(request: Request) {
  try {
    const identity = await getConsoleIdentity();
    const linkId = new URL(request.url).searchParams.get("id") || "";
    return NextResponse.json(await disconnectWeComIdentityLink(identity, linkId));
  } catch (error) {
    const known = error instanceof ConsoleAuthError || error instanceof IntegrationStoreError;
    if (!known) console.error("WeCom identity unlink failed", error);
    return NextResponse.json({
      error: known ? error.message : "企微身份解绑失败",
    }, { status: known ? error.status : 500 });
  }
}
