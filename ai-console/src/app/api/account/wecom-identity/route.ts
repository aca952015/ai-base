import { NextResponse } from "next/server";

import { ConsoleAuthError, getConsoleIdentity } from "@/lib/server/console-identity";
import {
  disconnectWeComIdentityLink,
  IntegrationStoreError,
} from "@/lib/server/integrations";
import {
  WECOM_CONSOLE_SESSION_COOKIE,
  wecomConsoleSessionCookieOptions,
} from "@/lib/server/wecom-console-session";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function DELETE() {
  try {
    const identity = await getConsoleIdentity();
    const response = NextResponse.json(await disconnectWeComIdentityLink(identity));
    response.cookies.set(
      WECOM_CONSOLE_SESSION_COOKIE,
      "",
      wecomConsoleSessionCookieOptions(0),
    );
    return response;
  } catch (error) {
    const known = error instanceof ConsoleAuthError || error instanceof IntegrationStoreError;
    if (!known) console.error("WeCom identity unlink failed", error);
    return NextResponse.json({
      error: known ? error.message : "企微身份解绑失败",
    }, { status: known ? error.status : 500 });
  }
}
