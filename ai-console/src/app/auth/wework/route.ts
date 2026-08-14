import { NextResponse } from "next/server";

import { ConsoleAuthError, getConsoleIdentity } from "@/lib/server/console-identity";
import {
  createWeComIdentityLinkRequest,
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
  provisionWeComRelayAuthorization,
  WeComRelayError,
} from "@/lib/server/wecom-relay";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET() {
  try {
    const identity = await getConsoleIdentity({ audience: aiConsoleAudience() });
    const credential = await getWeComRelayCredential();
    const linkRequest = await createWeComIdentityLinkRequest(identity);
    const authorizationUrl = await provisionWeComRelayAuthorization({
      requestToken: linkRequest.requestToken,
      expiresAt: linkRequest.expiresAt,
      credential,
    });
    const response = NextResponse.redirect(
      authorizationUrl,
      302,
    );
    response.cookies.set(
      WECOM_IDENTITY_LINK_COOKIE,
      linkRequest.browserNonce,
      wecomIdentityLinkCookieOptions(10 * 60),
    );
    response.headers.set("Cache-Control", "no-store, max-age=0");
    return response;
  } catch (error) {
    const known = error instanceof ConsoleAuthError
      || error instanceof IntegrationStoreError
      || error instanceof WeComRelayError;
    if (!known) console.error("WeCom identity link request failed", error);
    return NextResponse.redirect(wecomIdentityLinkResultUrl("failed"), 303);
  }
}
