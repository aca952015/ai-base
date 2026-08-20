import type { NextRequest } from "next/server";
import { NextResponse } from "next/server";

import {
  createWeComIdentityLoginRequest,
  IntegrationStoreError,
  resolveWeComIdentityLoginRequest,
} from "@/lib/server/integrations";
import {
  issueWeComConsoleSession,
  WECOM_CONSOLE_SESSION_COOKIE,
  wecomConsoleSessionCookieOptions,
} from "@/lib/server/wecom-console-session";
import { getWeComOrganizationIdForRelay } from "@/lib/server/wecom-authentication";
import {
  WECOM_IDENTITY_LINK_COOKIE,
  wecomIdentityLinkCookieOptions,
  wecomIdentityLinkLoginUrl,
  wecomIdentityLinkResultUrl,
  wecomIdentityStatusUrl,
} from "@/lib/server/wecom-identity-link-routing";
import {
  consumeWeComRelayIdentity,
  readWeComRelayResultHandoff,
  WeComRelayError,
} from "@/lib/server/wecom-relay";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

type LaunchRouteContext = {
  params: Promise<{ ticket: string }>;
};

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

function failedLaunchResponse(result = "failed") {
  const response = NextResponse.redirect(wecomIdentityStatusUrl(result), 303);
  response.headers.set("Cache-Control", "no-store, max-age=0");
  response.headers.set("Referrer-Policy", "no-referrer");
  return response;
}

export async function GET(request: NextRequest, context: LaunchRouteContext) {
  if (request.nextUrl.search) return failedLaunchResponse();
  let response: NextResponse;
  try {
    const { ticket } = await context.params;
    const handoff = readWeComRelayResultHandoff(ticket);
    const organizationId = await getWeComOrganizationIdForRelay(handoff.relayCallbackUrl);
    const relayIdentity = await consumeWeComRelayIdentity(ticket, handoff);
    const linkRequest = await createWeComIdentityLoginRequest(organizationId);
    const resolution = await resolveWeComIdentityLoginRequest(
      linkRequest.requestToken,
      linkRequest.browserNonce,
      relayIdentity,
    );
    if (resolution.status === "linked") {
      response = NextResponse.redirect(wecomIdentityLinkResultUrl("restored"), 303);
      response.cookies.set(
        WECOM_CONSOLE_SESSION_COOKIE,
        issueWeComConsoleSession(resolution.identity, resolution.identity.linkId),
        wecomConsoleSessionCookieOptions(),
      );
      response.cookies.set(
        WECOM_IDENTITY_LINK_COOKIE,
        "",
        wecomIdentityLinkCookieOptions(0),
      );
    } else {
      response = NextResponse.redirect(wecomIdentityLinkLoginUrl(linkRequest.requestToken), 303);
      response.cookies.set(
        WECOM_IDENTITY_LINK_COOKIE,
        linkRequest.browserNonce,
        wecomIdentityLinkCookieOptions(30 * 60),
      );
    }
    response.headers.set("Cache-Control", "no-store, max-age=0");
    response.headers.set("Referrer-Policy", "no-referrer");
  } catch (error) {
    const known = error instanceof IntegrationStoreError || error instanceof WeComRelayError;
    if (!known) console.error("WeCom identity result consumption failed", error);
    response = failedLaunchResponse(resultFor(error));
  }
  return response;
}
