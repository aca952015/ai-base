"use client";

import {
  AlertCircle,
  Bot,
  Braces,
  CheckCircle2,
  Code2,
  Copy,
  Link2,
  SquareTerminal,
} from "lucide-react";
import type { ReactNode } from "react";
import { useEffect, useRef, useState } from "react";

import { copyText } from "@/lib/client/clipboard";
import {
  formatCodexCliCommands,
  formatCursorMcpClientConfig,
  formatMcpClientConfig,
  formatWorkBuddyCliCommand,
} from "@/lib/control-plane/mcp-client-config";

type GuideTab = "general" | "clients";
type ClientTab = "workbuddy" | "cursor" | "codex";
type CopyTarget = "endpoint" | "json" | ClientTab;

const clientOptions: Array<{
  id: ClientTab;
  label: string;
  description: string;
  icon: ReactNode;
}> = [
  {
    id: "workbuddy",
    label: "WorkBuddy",
    description: "通过 CLI 写入当前用户配置，随后在客户端中完成连接。",
    icon: <SquareTerminal size={17} />,
  },
  {
    id: "cursor",
    label: "Cursor",
    description: "保存到 ~/.cursor/mcp.json，供 Cursor IDE 与 CLI 使用。",
    icon: <Code2 size={17} />,
  },
  {
    id: "codex",
    label: "Codex",
    description: "添加远程 MCP 后，使用第二行命令完成 OAuth 登录。",
    icon: <Bot size={17} />,
  },
];

export function McpClientSetupGuide({
  resourceUrl,
  resourceError,
}: {
  resourceUrl?: string;
  resourceError?: string;
}) {
  const [activeGuideTab, setActiveGuideTab] = useState<GuideTab>("general");
  const [activeClient, setActiveClient] = useState<ClientTab>("workbuddy");
  const [copiedTarget, setCopiedTarget] = useState<CopyTarget>();
  const [copyError, setCopyError] = useState("");
  const resetTimerRef = useRef<number | undefined>(undefined);

  useEffect(() => () => {
    if (resetTimerRef.current !== undefined) {
      window.clearTimeout(resetTimerRef.current);
    }
  }, []);

  async function copy(target: CopyTarget, value: string) {
    try {
      await copyText(value);
      if (resetTimerRef.current !== undefined) {
        window.clearTimeout(resetTimerRef.current);
      }
      setCopiedTarget(target);
      setCopyError("");
      resetTimerRef.current = window.setTimeout(() => {
        setCopiedTarget(undefined);
        resetTimerRef.current = undefined;
      }, 2_000);
    } catch (error) {
      setCopiedTarget(undefined);
      setCopyError(error instanceof Error ? error.message : "复制配置失败");
    }
  }

  const jsonConfig = resourceUrl ? formatMcpClientConfig(resourceUrl) : "";
  const clientValues: Record<ClientTab, string> = {
    workbuddy: resourceUrl ? formatWorkBuddyCliCommand(resourceUrl) : "",
    cursor: resourceUrl ? formatCursorMcpClientConfig(resourceUrl) : "",
    codex: resourceUrl ? formatCodexCliCommands(resourceUrl) : "",
  };
  const selectedClient = clientOptions.find((item) => item.id === activeClient)
    ?? clientOptions[0];

  return (
    <section className="mcp-setup-guide" aria-labelledby="mcp-setup-guide-title">
      <header className="mcp-setup-guide__header">
        <span className="mcp-setup-guide__icon"><Link2 size={20} /></span>
        <div>
          <h2 id="mcp-setup-guide-title">AI Base MCP 接入</h2>
          <p>管理员和员工均可使用。首次连接时，客户端会打开浏览器完成当前员工身份认证。</p>
        </div>
      </header>

      <div className="mcp-setup-guide__tabs" role="tablist" aria-label="配置类型">
        <button
          aria-controls="mcp-setup-general-panel"
          aria-selected={activeGuideTab === "general"}
          className={activeGuideTab === "general" ? "is-active" : undefined}
          id="mcp-setup-general-tab"
          onClick={() => setActiveGuideTab("general")}
          role="tab"
          type="button"
        >
          通用配置
        </button>
        <button
          aria-controls="mcp-setup-clients-panel"
          aria-selected={activeGuideTab === "clients"}
          className={activeGuideTab === "clients" ? "is-active" : undefined}
          id="mcp-setup-clients-tab"
          onClick={() => setActiveGuideTab("clients")}
          role="tab"
          type="button"
        >
          客户端配置
        </button>
      </div>

      {!resourceUrl ? (
        <div className="mcp-setup-guide__unavailable" role="status">
          <AlertCircle size={17} />
          <div>
            <strong>暂时无法生成配置</strong>
            <span>{resourceError || "管理员尚未配置公开的 MCP 地址。"}</span>
          </div>
        </div>
      ) : activeGuideTab === "general" ? (
        <div
          aria-labelledby="mcp-setup-general-tab"
          className="mcp-setup-guide__panel"
          id="mcp-setup-general-panel"
          role="tabpanel"
        >
          <div className="mcp-setup-guide__endpoint">
            <div>
              <span>MCP 地址</span>
              <code>{resourceUrl}</code>
            </div>
            <CopyButton
              copied={copiedTarget === "endpoint"}
              label="复制地址"
              onClick={() => void copy("endpoint", resourceUrl)}
            />
          </div>
          <ConfigSnippet
            title="通用 MCP JSON"
            description="适用于支持 Streamable HTTP 和 JSON 导入的 MCP 客户端"
            value={jsonConfig}
            icon={<Braces size={18} />}
            copied={copiedTarget === "json"}
            onCopy={() => void copy("json", jsonConfig)}
          />
        </div>
      ) : (
        <div
          aria-labelledby="mcp-setup-clients-tab"
          className="mcp-setup-guide__panel"
          id="mcp-setup-clients-panel"
          role="tabpanel"
        >
          <div className="mcp-setup-guide__client-tabs" role="tablist" aria-label="客户端">
            {clientOptions.map((client) => (
              <button
                aria-controls={`mcp-client-${client.id}-panel`}
                aria-selected={activeClient === client.id}
                className={activeClient === client.id ? "is-active" : undefined}
                id={`mcp-client-${client.id}-tab`}
                key={client.id}
                onClick={() => setActiveClient(client.id)}
                role="tab"
                type="button"
              >
                {client.icon}
                <span>{client.label}</span>
              </button>
            ))}
          </div>
          <div
            aria-labelledby={`mcp-client-${activeClient}-tab`}
            id={`mcp-client-${activeClient}-panel`}
            role="tabpanel"
          >
            <ConfigSnippet
              title={selectedClient.label}
              description={selectedClient.description}
              value={clientValues[activeClient]}
              icon={selectedClient.icon}
              copied={copiedTarget === activeClient}
              onCopy={() => void copy(activeClient, clientValues[activeClient])}
            />
          </div>
        </div>
      )}

      {copyError ? (
        <p className="mcp-setup-guide__error" role="alert">
          <AlertCircle size={14} />{copyError}
        </p>
      ) : null}
    </section>
  );
}

function ConfigSnippet({
  title,
  description,
  value,
  icon,
  copied,
  onCopy,
}: {
  title: string;
  description: string;
  value: string;
  icon: ReactNode;
  copied: boolean;
  onCopy: () => void;
}) {
  return (
    <article className="mcp-setup-guide__snippet">
      <header>
        <span>{icon}</span>
        <div>
          <strong>{title}</strong>
          <small>{description}</small>
        </div>
        <CopyButton copied={copied} label="复制配置" onClick={onCopy} />
      </header>
      <pre tabIndex={0}><code>{value}</code></pre>
    </article>
  );
}

function CopyButton({
  copied,
  label,
  onClick,
}: {
  copied: boolean;
  label: string;
  onClick: () => void;
}) {
  return (
    <button
      className="button button--secondary mcp-setup-guide__copy"
      type="button"
      onClick={onClick}
    >
      {copied ? <CheckCircle2 size={15} /> : <Copy size={15} />}
      {copied ? "已复制" : label}
    </button>
  );
}
