export type McpPublicResourceResolution =
  | { ok: true; url: string }
  | { ok: false; error: string };

export function normalizeMcpResourceUrl(resourceUrl: string) {
  if (!resourceUrl) throw new Error("MCP Resource URL 不能为空");
  if (resourceUrl !== resourceUrl.trim()) {
    throw new Error("MCP Resource URL 不能包含首尾空白");
  }

  // Keep this identical to mcp-access-gateway/config.go: resource identity is
  // compared as an exact OAuth string after all trailing slashes are removed.
  const value = resourceUrl.replace(/\/+$/, "");

  let parsed: URL;
  try {
    parsed = new URL(value);
  } catch {
    throw new Error("MCP Resource URL 必须是有效的绝对地址");
  }
  if (parsed.protocol !== "http:" && parsed.protocol !== "https:") {
    throw new Error("MCP Resource URL 仅支持 HTTP 或 HTTPS");
  }
  if (parsed.username || parsed.password || parsed.hash) {
    throw new Error("MCP Resource URL 不能包含用户凭据或片段");
  }
  return value;
}

export function resolveMcpPublicResourceUrl(
  configuredUrl: string | undefined,
): McpPublicResourceResolution {
  if (!configuredUrl?.trim()) {
    return {
      ok: false,
      error: "未配置 MCP_PUBLIC_RESOURCE_URL，无法生成客户端配置。",
    };
  }
  try {
    return { ok: true, url: normalizeMcpResourceUrl(configuredUrl) };
  } catch (error) {
    return {
      ok: false,
      error: error instanceof Error ? error.message : "MCP Resource URL 配置无效",
    };
  }
}

export function createMcpClientConfig(resourceUrl: string) {
  return {
    mcpServers: {
      "ai-base": {
        url: normalizeMcpResourceUrl(resourceUrl),
      },
    },
  };
}

export function formatMcpClientConfig(resourceUrl: string) {
  return `${JSON.stringify(createMcpClientConfig(resourceUrl), null, 2)}\n`;
}
