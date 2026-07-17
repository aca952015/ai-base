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
    description: "可维护的 Markdown 知识源、业务数据和向量索引。",
  },
  {
    id: "governance" as const,
    title: "质量与可观测",
    description: "评测门禁、调用链路和故障分析。",
  },
];

export const portalEntries: PortalEntry[] = [
  {
    id: "agent-runtime",
    category: "build",
    workspaceUrl: "http://localhost:18000/docs",
    workspaceLabel: "打开 API 工作台",
    managePath: "/agents",
    manageLabel: "管理 Agent",
  },
  {
    id: "bifrost",
    category: "build",
    workspaceUrl: "http://localhost:8080",
    workspaceLabel: "打开模型网关",
    managePath: "/capabilities#models",
    manageLabel: "管理模型能力",
  },
  {
    id: "open-connector",
    category: "build",
    workspaceUrl: "http://localhost:3100",
    workspaceLabel: "打开连接控制台",
    managePath: "/capabilities#connections",
    manageLabel: "管理连接能力",
  },
  {
    id: "silverbullet",
    category: "knowledge",
    workspaceUrl: "http://localhost:3001",
    workspaceLabel: "打开知识工作台",
    managePath: "/data#knowledge",
    manageLabel: "管理知识空间",
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
    workspaceUrl: "http://localhost:16686",
    workspaceLabel: "打开 Trace 工作台",
    managePath: "/observability",
    manageLabel: "管理可观测能力",
  },
];

export function getPortalEntry(id: ServiceId) {
  return portalEntries.find((entry) => entry.id === id);
}
