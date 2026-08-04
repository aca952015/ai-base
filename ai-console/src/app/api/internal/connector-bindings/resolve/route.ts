import { createHash, timingSafeEqual } from "node:crypto";

import { NextResponse } from "next/server";

import {
  IntegrationStoreError,
  resolveEmployeeConnectorBindings,
} from "@/lib/server/integrations";
import { OpenConnectorError } from "@/lib/server/open-connector";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

function authorized(request: Request) {
  const expected = process.env.MCP_CONNECTOR_BINDING_RESOLVER_TOKEN?.trim();
  const authorization = request.headers.get("authorization") || "";
  const actual = authorization.startsWith("Bearer ") ? authorization.slice(7).trim() : "";
  if (!expected || !actual) return false;
  const expectedDigest = createHash("sha256").update(expected).digest();
  const actualDigest = createHash("sha256").update(actual).digest();
  return timingSafeEqual(expectedDigest, actualDigest);
}

export async function POST(request: Request) {
  if (!authorized(request)) {
    return NextResponse.json({ error: "unauthorized" }, { status: 401 });
  }
  try {
    const body = await request.json() as unknown;
    if (!body || typeof body !== "object" || Array.isArray(body)) {
      throw new IntegrationStoreError("请求体必须是 JSON 对象", 400);
    }
    const input = body as Record<string, unknown>;
    return NextResponse.json(await resolveEmployeeConnectorBindings({
      issuer: typeof input.issuer === "string" ? input.issuer : "",
      subject: typeof input.subject === "string" ? input.subject : "",
      email: typeof input.email === "string" ? input.email : undefined,
      groups: Array.isArray(input.groups)
        ? input.groups.filter((group): group is string => typeof group === "string")
        : undefined,
      wecomUserIdHash: typeof input.wecomUserIdHash === "string" ? input.wecomUserIdHash : undefined,
      clientId: typeof input.clientId === "string" ? input.clientId : undefined,
      service: typeof input.service === "string" ? input.service : undefined,
      requestedConnectionName: typeof input.requestedConnectionName === "string"
        ? input.requestedConnectionName
        : undefined,
      actionId: typeof input.actionId === "string" ? input.actionId : undefined,
    }));
  } catch (error) {
    const known = error instanceof IntegrationStoreError || error instanceof OpenConnectorError;
    if (!known) console.error("Connector binding resolution failed", error);
    return NextResponse.json({
      error: known ? error.message : "Connector binding resolution failed",
      ...(error instanceof IntegrationStoreError && error.code ? { code: error.code } : {}),
      ...(error instanceof IntegrationStoreError && error.details ? { details: error.details } : {}),
    }, { status: known ? error.status : 500 });
  }
}
