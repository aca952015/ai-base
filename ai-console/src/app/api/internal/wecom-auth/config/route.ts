import { createHash, timingSafeEqual } from "node:crypto";

import { NextResponse } from "next/server";

import {
  IntegrationStoreError,
} from "@/lib/server/integrations";
import {
  getWeComAuthenticationConfiguration,
  getWeComAuthenticationCredential,
} from "@/lib/server/wecom-authentication";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

function authorized(request: Request) {
  const expected = process.env.WECOM_AUTH_BRIDGE_CONFIG_TOKEN?.trim();
  const authorization = request.headers.get("authorization") || "";
  const actual = authorization.startsWith("Bearer ") ? authorization.slice(7).trim() : "";
  if (!expected || !actual) return false;
  return timingSafeEqual(
    createHash("sha256").update(expected).digest(),
    createHash("sha256").update(actual).digest(),
  );
}

export async function GET(request: Request) {
  if (!authorized(request)) {
    return NextResponse.json({ error: "unauthorized" }, { status: 401 });
  }
  const runtime = await getWeComAuthenticationConfiguration();
  try {
    const application = await getWeComAuthenticationCredential();
    return NextResponse.json({
      configured: true,
      runtime: {
        publicBaseUrl: runtime.publicBaseUrl,
        publicCallbackUrl: runtime.effectiveCallbackUrl,
        emailDomain: runtime.emailDomain,
        updatedAt: runtime.updatedAt,
      },
      application: {
        id: application.id,
        name: application.name,
        corpId: application.corpId,
        appSecret: application.appSecret,
        updatedAt: application.updatedAt,
      },
    }, {
      headers: {
        "Cache-Control": "no-store",
      },
    });
  } catch (error) {
    const known = error instanceof IntegrationStoreError;
    if (!known) console.error("WeCom auth configuration lookup failed", error);
    return NextResponse.json({
      configured: false,
      runtime: {
        publicBaseUrl: runtime.publicBaseUrl,
        publicCallbackUrl: runtime.effectiveCallbackUrl,
        emailDomain: runtime.emailDomain,
        updatedAt: runtime.updatedAt,
      },
      error: known ? error.message : "WeCom auth configuration lookup failed",
    }, {
      status: known ? error.status : 500,
      headers: {
        "Cache-Control": "no-store",
      },
    });
  }
}
