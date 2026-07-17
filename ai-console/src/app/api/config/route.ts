import { NextResponse } from "next/server";

import {
  readConfig,
  updateConfig,
  validateConfigPatch,
} from "@/lib/server/config";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET() {
  return NextResponse.json({ config: await readConfig() });
}

export async function PATCH(request: Request) {
  let body: unknown;
  try {
    body = await request.json();
  } catch {
    return NextResponse.json({ error: "invalid JSON body" }, { status: 400 });
  }

  const validation = validateConfigPatch(body);
  if (!validation.ok) {
    return NextResponse.json(
      { error: "invalid config patch", details: validation.errors },
      { status: 400 },
    );
  }
  return NextResponse.json({
    config: await updateConfig(validation.value),
    message: "配置已保存",
  });
}
