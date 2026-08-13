import type { ServiceId } from "./types";

export type PortalCategory = "build" | "knowledge" | "governance";

export type PortalEntry = {
  id: ServiceId;
  category: PortalCategory;
  workspaceUrl?: string;
  workspaceLabel?: string;
  managePath: string;
  manageLabel: string;
};

export const portalCategories = [
  {
    id: "build" as const,
    title: "构建与运行",
    description: "Agent 运行、模型访问和外部系统连接。",
  },
  {
    id: "knowledge" as const,
    title: "知识与数据",
    description: "文档、混合检索、知识图谱和共享数据基础设施。",
  },
  {
    id: "governance" as const,
    title: "质量与可观测",
    description: "评测门禁、调用链路和故障分析。",
  },
];

export const portalEntries: PortalEntry[] = [
  {
    id: "global-gateway",
    category: "build",
    workspaceUrl: "http://localhost:8080",
    workspaceLabel: "查看功能入口",
    managePath: "/settings#service-global-gateway",
    manageLabel: "管理统一入口",
  },
  {
    id: "agent-runtime",
    category: "build",
    workspaceUrl: "http://runtime.localhost:8080/docs",
    workspaceLabel: "打开 API 工作台",
    managePath: "/agents",
    manageLabel: "管理 Agent",
  },
  {
    id: "mcp-access-gateway",
    category: "build",
    managePath: "/mcp",
    manageLabel: "管理 MCP 注册",
  },
  {
    id: "llm-gateway",
    category: "build",
    managePath: "/model-channels",
    manageLabel: "配置模型渠道",
  },
  {
    id: "open-connector",
    category: "build",
    workspaceUrl: "https://open-connector.localhost.pomerium.io:8443",
    workspaceLabel: "打开连接控制台",
    managePath: "/capabilities#connections",
    manageLabel: "管理连接能力",
  },
  {
    id: "lightrag",
    category: "knowledge",
    workspaceUrl: "http://knowledge.localhost:8080/webui",
    workspaceLabel: "打开知识工作台",
    managePath: "/data#knowledge",
    manageLabel: "管理知识索引",
  },
  {
    id: "rag-mcp",
    category: "knowledge",
    managePath: "/mcp",
    manageLabel: "查看 MCP 工具",
  },
  {
    id: "postgres",
    category: "knowledge",
    managePath: "/data",
    manageLabel: "管理数据与索引",
  },
  {
    id: "promptfoo",
    category: "governance",
    managePath: "/evaluations",
    manageLabel: "管理评测门禁",
  },
  {
    id: "jaeger",
    category: "governance",
    workspaceUrl: "https://jaeger.localhost.pomerium.io:8443",
    workspaceLabel: "打开 Trace 工作台",
    managePath: "/observability",
    manageLabel: "管理可观测能力",
  },
];

export function getPortalEntry(id: ServiceId) {
  return portalEntries.find((entry) => entry.id === id);
}
