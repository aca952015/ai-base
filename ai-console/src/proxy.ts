import type { NextRequest } from "next/server";
import { NextResponse } from "next/server";

function assertionEmail(request: NextRequest) {
  const direct = request.headers.get("x-pomerium-claim-email")?.trim().toLowerCase();
  if (direct) return direct;
  const assertion = request.headers.get("x-pomerium-jwt-assertion");
  const payload = assertion?.split(".")[1];
  if (!payload) return "";
  try {
    const claims = JSON.parse(Buffer.from(payload, "base64url").toString("utf8")) as unknown;
    return claims && typeof claims === "object" && "email" in claims && typeof claims.email === "string"
      ? claims.email.trim().toLowerCase()
      : "";
  } catch {
    return "";
  }
}

function isAdmin(email: string) {
  return (process.env.AI_CONSOLE_ADMIN_EMAILS || "admin@bluetron.cn")
    .split(",")
    .map((item) => item.trim().toLowerCase())
    .filter(Boolean)
    .includes(email);
}

export function proxy(request: NextRequest) {
  const pathname = request.nextUrl.pathname;
  if (
    pathname === "/api/services"
    || pathname.startsWith("/api/internal/")
    || pathname.startsWith("/_next/")
    || pathname === "/favicon.ico"
  ) {
    return NextResponse.next();
  }

  const email = assertionEmail(request);
  const developmentIdentity = process.env.AI_CONSOLE_DEV_IDENTITY_ENABLED === "true";
  if (!email && !developmentIdentity) {
    return NextResponse.json({ error: "未认证" }, { status: 401 });
  }

  if (
    pathname === "/account"
    || pathname === "/client-setup"
    || pathname === "/auth/wework"
    || pathname === "/auth/wework/complete"
    || pathname.startsWith("/api/account/")
  ) {
    return NextResponse.next();
  }

  if (!developmentIdentity && !isAdmin(email)) {
    if (pathname.startsWith("/api/")) {
      return NextResponse.json({ error: "仅管理员可以访问该功能" }, { status: 403 });
    }
    const destination = request.nextUrl.clone();
    destination.pathname = "/account";
    destination.search = "";
    return NextResponse.redirect(destination);
  }

  return NextResponse.next();
}

export const config = {
  matcher: ["/((?!_next/static|_next/image|.*\\.(?:svg|png|jpg|jpeg|gif|webp)$).*)"],
};
