import { NextResponse } from "next/server";

import { parseActionRequest, runAction } from "@/lib/server/actions";
import { readConfig } from "@/lib/server/config";

export const runtime = "nodejs";

export async function POST(request: Request) {
  let body: unknown;
  try {
    body = await request.json();
  } catch {
    return NextResponse.json({ error: "invalid JSON body" }, { status: 400 });
  }

  const parsed = parseActionRequest(body);
  if (!parsed.ok) {
    return NextResponse.json({ error: parsed.error }, { status: 400 });
  }
  return NextResponse.json(await runAction(parsed.action, await readConfig()));
}
