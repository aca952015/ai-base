import { describe, expect, it } from "vitest";

import {
  createCursorMcpClientConfig,
  createMcpClientConfig,
  createWorkBuddyMcpServerConfig,
  formatCodexCliCommands,
  formatCursorMcpClientConfig,
  formatMcpClientConfig,
  formatWorkBuddyCliCommand,
  normalizeMcpResourceUrl,
  resolveMcpPublicResourceUrl,
} from "./mcp-client-config";

describe("MCP client config", () => {
  it("builds the generic client configuration for the public MCP resource", () => {
    expect(createMcpClientConfig("https://ai.example.com/mcp")).toEqual({
      mcpServers: {
        "ai-base": {
          url: "https://ai.example.com/mcp",
        },
      },
    });
  });

  it("formats a copy-ready JSON document", () => {
    expect(formatMcpClientConfig("http://127.0.0.1:8080/mcp")).toBe(
      [
        "{",
        '  "mcpServers": {',
        '    "ai-base": {',
        '      "url": "http://127.0.0.1:8080/mcp"',
        "    }",
        "  }",
        "}",
        "",
      ].join("\n"),
    );
  });

  it("builds a WorkBuddy HTTP server configuration", () => {
    expect(createWorkBuddyMcpServerConfig("https://ai.example.com/mcp/")).toEqual({
      type: "http",
      url: "https://ai.example.com/mcp",
    });
  });

  it("formats a user-scoped WorkBuddy CLI command", () => {
    expect(formatWorkBuddyCliCommand("https://ai.example.com/mcp")).toBe(
      `codebuddy mcp add-json --scope user ai-base '{"type":"http","url":"https://ai.example.com/mcp"}'`,
    );
  });

  it("shell-quotes apostrophes in a WorkBuddy CLI command", () => {
    expect(formatWorkBuddyCliCommand("https://ai.example.com/mcp?name=o'reilly")).toBe(
      `codebuddy mcp add-json --scope user ai-base '{"type":"http","url":"https://ai.example.com/mcp?name=o'\\''reilly"}'`,
    );
  });

  it("formats a global Cursor-compatible MCP configuration", () => {
    expect(createCursorMcpClientConfig("https://ai.example.com/mcp")).toEqual({
      mcpServers: {
        "ai-base": {
          type: "http",
          url: "https://ai.example.com/mcp",
        },
      },
    });
    expect(formatCursorMcpClientConfig("https://ai.example.com/mcp")).toContain(
      '"type": "http"',
    );
  });

  it("formats Codex add and OAuth login commands", () => {
    expect(formatCodexCliCommands("https://ai.example.com/mcp")).toBe(
      [
        "codex mcp add ai-base --url 'https://ai.example.com/mcp'",
        "codex mcp login ai-base",
      ].join("\n"),
    );
  });

  it("shell-quotes the MCP URL in Codex commands", () => {
    expect(formatCodexCliCommands("https://ai.example.com/mcp?name=o'reilly")).toContain(
      "--url 'https://ai.example.com/mcp?name=o'\\''reilly'",
    );
  });

  it.each([
    ["", "不能为空"],
    ["   ", "首尾空白"],
    [" https://ai.example.com/mcp", "首尾空白"],
    ["https://ai.example.com/mcp ", "首尾空白"],
    ["/mcp", "绝对地址"],
    ["not-a-url", "绝对地址"],
    ["ftp://ai.example.com/mcp", "HTTP 或 HTTPS"],
    ["https://user:secret@ai.example.com/mcp", "用户凭据或片段"],
    ["https://ai.example.com/mcp#tools", "用户凭据或片段"],
  ])("rejects an unsafe MCP resource URL: %s", (value, message) => {
    expect(() => normalizeMcpResourceUrl(value)).toThrow(message);
  });

  it("uses only the explicitly configured public resource URL", () => {
    expect(resolveMcpPublicResourceUrl("https://mcp.example.com/mcp")).toEqual({
      ok: true,
      url: "https://mcp.example.com/mcp",
    });
  });

  it.each([undefined, ""])(
    "does not silently fall back when the public resource URL is missing",
    (value) => {
      expect(resolveMcpPublicResourceUrl(value)).toEqual({
        ok: false,
        error: "未配置 MCP_PUBLIC_RESOURCE_URL，无法生成客户端配置。",
      });
    },
  );

  it.each([
    ["https://mcp.example.com/mcp/", "https://mcp.example.com/mcp"],
    ["https://mcp.example.com/mcp///", "https://mcp.example.com/mcp"],
    ["https://MCP.EXAMPLE.com:443/", "https://MCP.EXAMPLE.com:443"],
    ["https://mcp.example.com/%7Etools", "https://mcp.example.com/%7Etools"],
    ["https://mcp.example.com/mcp?next=/", "https://mcp.example.com/mcp?next="],
  ])(
    "matches the gateway resource identity normalization for %s",
    (configuredUrl, expectedUrl) => {
      expect(normalizeMcpResourceUrl(configuredUrl)).toBe(expectedUrl);
    },
  );
});
