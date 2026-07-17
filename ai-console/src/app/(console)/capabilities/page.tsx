import { ArrowRight, Blocks, BrainCircuit, ExternalLink, KeyRound, Network, NotebookTabs, ShieldCheck } from "lucide-react";
import Link from "next/link";

import { PageHeader } from "@/components/page-header";
import { SectionCard } from "@/components/section-card";
import { StatusPill } from "@/components/status-pill";
import type { ServiceStatus } from "@/lib/control-plane/types";
import { formatNumber } from "@/lib/format";
import { getComponentData } from "@/lib/server/component-data";
import { readConfig } from "@/lib/server/config";

export const dynamic = "force-dynamic";

export default async function CapabilitiesPage() {
  const data = await getComponentData(await readConfig());
  const statusOf = (id: string): ServiceStatus => data.services.find((service) => service.id === id)?.status || "offline";
  const registeredTools = Array.from(new Set(data.runtime.agents.flatMap((agent) => agent.tools)));
  const capabilityCards = [
    { id: "models", title: "大模型网关", product: "Envoy AI Gateway", icon: BrainCircuit, status: statusOf("llm-gateway"), metric: `${data.modelGateway.channelCount} 个渠道 / ${data.modelGateway.modelCount} 个模型`, detail: "Console 管理上游渠道；网关只承担协议转换、模型路由和流式转发。", serviceId: "llm-gateway", managePath: "/model-channels" },
    { id: "tools", title: "内部工具", product: "Agent Runtime", icon: Blocks, status: statusOf("agent-runtime"), metric: `${registeredTools.length} 个唯一工具`, detail: `${data.runtime.agents.length} 个 Runtime Agent 的注册结果。`, serviceId: "agent-runtime" },
    { id: "connections", title: "外部系统连接", product: "Open Connector", icon: Network, status: statusOf("open-connector"), metric: `${data.connector.connectionCount} 个连接 · ${data.connector.authenticatedAppCount} 个需认证`, detail: `${formatNumber(data.connector.providerCount)} 个可用 Provider。`, serviceId: "open-connector" },
    { id: "knowledge", title: "知识能力", product: "SilverBullet + pgvector", icon: NotebookTabs, status: statusOf("silverbullet"), metric: `${data.knowledge.documentCount} 篇 Markdown · pgvector ${data.runtime.pgvector}`, detail: "Markdown 文件是真实知识源；尚未建立的切片不填充演示数量。", serviceId: "silverbullet" },
  ];

  return (
    <div className="page-stack">
      <PageHeader eyebrow="真实能力目录" title="能力管理" description="汇总 Envoy AI Gateway、Agent Runtime、OpenConnector 与 SilverBullet 的实际配置和数据。" />
      <section className="capability-grid" aria-label="能力目录">
        {capabilityCards.map((item) => {
          const Icon = item.icon;
          const manageHref = "managePath" in item && item.managePath
            ? item.managePath
            : `/settings#service-${item.serviceId}`;
          return <article className="capability-card" id={item.id} key={item.id}><div className="capability-card__top"><span className="capability-icon"><Icon size={20} /></span><StatusPill status={item.status} compact /></div><div><span className="card-kicker">{item.product}</span><h2>{item.title}</h2></div><strong className="capability-metric">{item.metric}</strong><p>{item.detail}</p><Link href={manageHref}>管理配置 <ArrowRight size={14} /></Link></article>;
        })}
      </section>
      <div className="dashboard-grid dashboard-grid--wide">
        <SectionCard className="grid-span-2" title="OpenConnector 连接" description="列表来自 server-only Admin API；Token 不会发送到浏览器。" action={<a className="section-link" href="http://localhost:3100" target="_blank" rel="noreferrer">打开连接控制台 <ExternalLink size={14} /></a>}>
          {data.connector.connections.length ? <div className="table-scroll"><table className="data-table"><thead><tr><th>Provider / 连接名</th><th>认证类型</th><th>配置状态</th><th>默认连接</th></tr></thead><tbody>{data.connector.connections.map((connection) => <tr key={connection.id}><td data-label="Provider / 连接名"><div className="service-identity"><strong>{connection.service}</strong><span className="cell-mono">{connection.connectionName}</span></div></td><td data-label="认证类型" className="cell-mono">{connection.authType}</td><td data-label="配置状态"><StatusPill status={connection.configured ? "healthy" : "unconfigured"} compact /></td><td data-label="默认连接">{connection.isDefault ? "是" : "否"}</td></tr>)}</tbody></table></div> : <div className="empty-data"><strong>暂无连接</strong><span>在 OpenConnector 中创建连接后会显示在这里。</span></div>}
        </SectionCard>
        <SectionCard title="Runtime 工具注册" description="工具名称直接来自 Agent Runtime `/v1/agents`。">
          {registeredTools.length ? <ul className="secret-list">{registeredTools.map((tool) => <li key={tool}><span><Blocks size={15} /><strong className="cell-mono">{tool}</strong></span><span className="secret-state is-ready"><ShieldCheck size={14} /> 已注册</span></li>)}</ul> : <div className="empty-data"><strong>尚未注册工具</strong><span>Runtime 返回工具后会显示在这里。</span></div>}
          <div className="inline-callout"><KeyRound size={17} /><div><strong>凭证最小化</strong><span>控制台仅展示连接元数据，不读取或回显 SaaS 凭证。</span></div></div>
        </SectionCard>
      </div>
    </div>
  );
}
