import type { NextRequest } from "next/server";
import { NextResponse } from "next/server";

import { ConsoleAuthError, getConsoleIdentity } from "@/lib/server/console-identity";
import {
  completeVerifiedWeComIdentityLinkRequest,
  IntegrationStoreError,
} from "@/lib/server/integrations";
import {
  WECOM_IDENTITY_LINK_COOKIE,
  aiConsoleAudience,
  wecomIdentityLinkCookieOptions,
  wecomIdentityLinkResultUrl,
} from "@/lib/server/wecom-identity-link-routing";
import {
  issueWeComConsoleSession,
  WECOM_CONSOLE_SESSION_COOKIE,
  wecomConsoleSessionCookieOptions,
} from "@/lib/server/wecom-console-session";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

function resultFor(error: unknown) {
  if (!(error instanceof IntegrationStoreError)) return "failed";
  switch (error.code) {
    case "expired_wecom_link_request":
      return "expired";
    case "wecom_identity_conflict":
      return "conflict";
    case "invalid_wecom_identity":
    case "invalid_wecom_link_request":
      return "invalid";
    default:
      return "failed";
  }
}

export async function GET(request: NextRequest) {
  let result = "linked";
  let consoleSession: string | undefined;
  try {
    const requestToken = request.nextUrl.searchParams.get("request") || "";
    const browserNonce = request.cookies.get(WECOM_IDENTITY_LINK_COOKIE)?.value || "";
    const platformIdentity = await getConsoleIdentity({ audience: aiConsoleAudience() });
    await completeVerifiedWeComIdentityLinkRequest(requestToken, browserNonce, platformIdentity);
    consoleSession = issueWeComConsoleSession(platformIdentity);
  } catch (error) {
    result = resultFor(error);
    const known = error instanceof ConsoleAuthError || error instanceof IntegrationStoreError;
    if (!known) console.error("WeCom identity first-link completion failed", error);
  }

  const response = NextResponse.redirect(wecomIdentityLinkResultUrl(result), 303);
  response.cookies.set(
    WECOM_IDENTITY_LINK_COOKIE,
    "",
    wecomIdentityLinkCookieOptions(0),
  );
  if (consoleSession) {
    response.cookies.set(
      WECOM_CONSOLE_SESSION_COOKIE,
      consoleSession,
      wecomConsoleSessionCookieOptions(),
    );
  }
  response.headers.set("Cache-Control", "no-store, max-age=0");
  return response;
}
