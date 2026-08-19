import type { NextRequest } from "next/server";
import { NextResponse } from "next/server";

import {
  createWeComIdentityLoginRequest,
  IntegrationStoreError,
} from "@/lib/server/integrations";
import {
  WECOM_IDENTITY_LINK_COOKIE,
  wecomIdentityLinkCookieOptions,
  wecomIdentityStatusUrl,
} from "@/lib/server/wecom-identity-link-routing";
import { getWeComRelayCredential } from "@/lib/server/wecom-authentication";
import {
  provisionWeComRelayAuthorization,
  WeComRelayError,
} from "@/lib/server/wecom-relay";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET(request: NextRequest) {
  const organizationId = request.nextUrl.searchParams.get("organization") || undefined;
  try {
    const credential = await getWeComRelayCredential(organizationId);
    const linkRequest = await createWeComIdentityLoginRequest(credential.organizationId);
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
      wecomIdentityLinkCookieOptions(30 * 60),
    );
    response.headers.set("Cache-Control", "no-store, max-age=0");
    return response;
  } catch (error) {
    const known = error instanceof IntegrationStoreError
      || error instanceof WeComRelayError;
    if (!known) console.error("WeCom identity link request failed", error);
    return NextResponse.redirect(wecomIdentityStatusUrl("failed", organizationId), 303);
  }
}
