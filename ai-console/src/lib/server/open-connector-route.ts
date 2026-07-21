import { NextResponse } from "next/server";

import { OpenConnectorError } from "./open-connector";

export function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}
export async function readJsonRecord(request: Request) {
  const payload = await request.json().catch(() => undefined) as unknown;
  if (!isRecord(payload)) throw new OpenConnectorError("请求体必须是 JSON 对象", 400);
  return payload;
}

export function readStringRecord(value: unknown, field: string) {
  if (value === undefined) return {};
  if (!isRecord(value)) throw new OpenConnectorError(`${field} 必须是对象`, 400);
  const result: Record<string, string> = {};
  for (const [key, item] of Object.entries(value)) {
    if (typeof item !== "string") throw new OpenConnectorError(`${field}.${key} 必须是字符串`, 400);
    result[key] = item;
  }
  return result;
}

export function openConnectorErrorResponse(error: unknown) {
  const known = error instanceof OpenConnectorError;
  return NextResponse.json(
    { error: known ? error.message : "OpenConnector 请求失败" },
    { status: known ? error.status : 502 },
  );
}
