const DEFAULT_CONSOLE_URL = "https://ai-console.localhost.pomerium.io:8443";

export const WECOM_IDENTITY_LINK_COOKIE = "ai_base_wecom_identity_link";

function configuredConsoleOrigin() {
  const parsed = new URL(process.env.AI_CONSOLE_PUBLIC_URL?.trim() || DEFAULT_CONSOLE_URL);
  if (
    parsed.protocol !== "https:"
    || parsed.username
    || parsed.password
    || parsed.pathname !== "/"
    || parsed.search
    || parsed.hash
  ) {
    throw new Error("AI Console 公开地址必须是无账号、路径、查询参数和片段的 HTTPS Origin");
  }
  return parsed.origin;
}

export function aiConsoleAudience() {
  return new URL(configuredConsoleOrigin()).hostname;
}

export function wecomRelayApplicationHomepageUrl(relayCallbackUrl: string) {
  const callback = new URL(relayCallbackUrl);
  return new URL("/launch/wecom", callback.origin);
}

export function wecomIdentityLinkResultUrl(result: string) {
  const url = new URL("/account", configuredConsoleOrigin());
  url.searchParams.set("wecom_link", result);
  return url;
}

export function wecomIdentityLinkLoginUrl(requestToken: string) {
  const url = new URL("/auth/wework/link", configuredConsoleOrigin());
  url.searchParams.set("request", requestToken);
  return url;
}

export function wecomIdentityStatusUrl(result: string) {
  const url = new URL("/auth/wework/status", configuredConsoleOrigin());
  url.searchParams.set("result", result);
  return url;
}

export function wecomIdentityLinkCookieOptions(maxAge: number) {
  return {
    httpOnly: true,
    maxAge,
    path: "/auth/wework",
    sameSite: "lax" as const,
    secure: true,
  };
}
