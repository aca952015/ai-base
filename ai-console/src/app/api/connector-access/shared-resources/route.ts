import { NextResponse } from "next/server";

import type { SharedConnectorGrantInput } from "@/lib/control-plane/connector-access";
import {
  getSharedConnectorAccess,
  saveSharedConnectorResource,
} from "@/lib/server/connector-access";
import { ConsoleAuthError, requireConsoleAdmin } from "@/lib/server/console-identity";
import { IntegrationStoreError } from "@/lib/server/integrations";
import { OpenConnectorError } from "@/lib/server/open-connector";
import { isRecord, readJsonRecord } from "@/lib/server/open-connector-route";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

function errorResponse(error: unknown) {
  const known = error instanceof IntegrationStoreError
    || error instanceof ConsoleAuthError
    || error instanceof OpenConnectorError;
  if (!known) console.error("Shared connector access request failed", error);
  return NextResponse.json(
    { error: known ? error.message : "受控共享配置操作失败" },
    { status: known ? error.status : 500 },
  );
}

function grantInputs(value: unknown): SharedConnectorGrantInput[] {
  if (!Array.isArray(value)) throw new IntegrationStoreError("grants 必须是数组", 400);
  return value.map((item) => {
    if (!isRecord(item)) throw new IntegrationStoreError("授权规则必须是对象", 400);
    return {
      principalType: item.principalType === "group" ? "group" : "user",
      principalSubject: typeof item.principalSubject === "string" ? item.principalSubject : undefined,
      principalEmail: typeof item.principalEmail === "string" ? item.principalEmail : undefined,
      groupName: typeof item.groupName === "string" ? item.groupName : undefined,
      actionIds: Array.isArray(item.actionIds)
        ? item.actionIds.filter((action): action is string => typeof action === "string")
        : [],
      startsAt: typeof item.startsAt === "string" ? item.startsAt : undefined,
      expiresAt: typeof item.expiresAt === "string" ? item.expiresAt : undefined,
      enabled: item.enabled !== false,
    };
  });
}

export async function GET() {
  try {
    await requireConsoleAdmin();
    return NextResponse.json(await getSharedConnectorAccess());
  } catch (error) {
    return errorResponse(error);
  }
}

export async function PUT(request: Request) {
  try {
    const identity = await requireConsoleAdmin();
    const body = await readJsonRecord(request);
    const resource = await saveSharedConnectorResource(identity, {
      service: typeof body.service === "string" ? body.service : "",
      connectionName: typeof body.connectionName === "string" ? body.connectionName : "",
      displayName: typeof body.displayName === "string" ? body.displayName : "",
      securityDomain: typeof body.securityDomain === "string" ? body.securityDomain : undefined,
      authorizationMode: body.authorizationMode === "wecom_visibility" ? "wecom_visibility" : "manual",
      wecomOrganizationId: typeof body.wecomOrganizationId === "string" ? body.wecomOrganizationId : undefined,
      actionIds: Array.isArray(body.actionIds)
        ? body.actionIds.filter((action): action is string => typeof action === "string")
        : [],
      enabled: body.enabled !== false,
      grants: grantInputs(body.grants),
    });
    return NextResponse.json({ resource });
  } catch (error) {
    return errorResponse(error);
  }
}
