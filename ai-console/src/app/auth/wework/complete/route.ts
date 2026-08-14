import type { NextRequest } from "next/server";
import { NextResponse } from "next/server";

import { ConsoleAuthError, getConsoleIdentity } from "@/lib/server/console-identity";
import {
  completeWeComIdentityLinkRequest,
  IntegrationStoreError,
} from "@/lib/server/integrations";
import {
  WECOM_IDENTITY_LINK_COOKIE,
  aiConsoleAudience,
  wecomIdentityLinkCookieOptions,
  wecomIdentityLinkResultUrl,
} from "@/lib/server/wecom-identity-link-routing";
import { getWeComRelayCredential } from "@/lib/server/wecom-authentication";
import {
  verifyWeComRelayResult,
  WeComRelayError,
} from "@/lib/server/wecom-relay";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

function resultFor(error: unknown) {
  if (error instanceof WeComRelayError) {
    if (error.code === "access_denied") return "denied";
    if (error.code === "invalid_relay_result") return "invalid";
    return "failed";
  }
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
  try {
    const ticket = request.nextUrl.searchParams.get("result") || "";
    const browserNonce = request.cookies.get(WECOM_IDENTITY_LINK_COOKIE)?.value || "";
    const platformIdentity = await getConsoleIdentity({ audience: aiConsoleAudience() });
    const credential = await getWeComRelayCredential();
    const relayIdentity = verifyWeComRelayResult(ticket, credential.relayCallbackUrl);
    await completeWeComIdentityLinkRequest(
      relayIdentity.requestToken,
      browserNonce,
      platformIdentity,
      relayIdentity,
    );
  } catch (error) {
    result = resultFor(error);
    const known = error instanceof ConsoleAuthError
      || error instanceof IntegrationStoreError
      || error instanceof WeComRelayError;
    if (!known) console.error("WeCom identity link completion failed", error);
  }
  const response = new NextResponse(null, {
    status: 303,
    headers: {
      Location: wecomIdentityLinkResultUrl(result).toString(),
    },
  });
  response.cookies.set(
    WECOM_IDENTITY_LINK_COOKIE,
    "",
    wecomIdentityLinkCookieOptions(0),
  );
  response.headers.set("Cache-Control", "no-store, max-age=0");
  return response;
}
