import { ArrowLeft, Blocks, BrainCircuit, Clock3, Database, GitBranch } from "lucide-react";
import Link from "next/link";
import { notFound } from "next/navigation";

import { MetricCard } from "@/components/metric-card";
import { PageHeader } from "@/components/page-header";
import { SectionCard } from "@/components/section-card";
import { StatusPill } from "@/components/status-pill";
import { formatDateTime, formatNumber } from "@/lib/format";
import { getComponentData } from "@/lib/server/component-data";
import { readConfig } from "@/lib/server/config";

export const dynamic = "force-dynamic";

export default async function AgentDetailPage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const { runtime } = await getComponentData(await readConfig());
  const agent = runtime.agents.find((item) => item.id === id);
  if (!agent) notFound();
  const events = runtime.recentEvents.filter((event) => event.agentId === agent.id);

  return (
    <div className="page-stack">
      <Link className="back-link" href="/agents"><ArrowLeft size={15} /> 返回 Agent 列表</Link>
      <PageHeader eyebrow={`Runtime · ${agent.id}`} title={agent.name} description="展示 Agent Runtime 注册配置和 PostgreSQL 中的实际运行事件。" actions={<StatusPill status={agent.status === "ready" ? "healthy" : "idle"} />} />
      <section className="metric-grid" aria-label={`${agent.name}指标`}>
        <MetricCard label="运行事件" value={formatNumber(agent.runCount)} detail="全部已记录事件" trend="PostgreSQL" icon={GitBranch} />
        <MetricCard label="最后运行" value={agent.latestRunAt ? formatDateTime(agent.latestRunAt) : "暂无"} detail="runtime_events" trend="真实时间" icon={Clock3} />
        <MetricCard label="注册工具" value={formatNumber(agent.tools.length)} detail="Runtime 配置" trend="只读" icon={Blocks} />
        <MetricCard label="模型策略" value={agent.modelAlias || "未配置"} detail="Runtime 网关别名" trend="Runtime" icon={BrainCircuit} />
      </section>
      <div className="dashboard-grid dashboard-grid--equal">
        <SectionCard title="运行配置" description="来自当前 Runtime 注册表的只读数据。">
          <dl className="detail-list"><div><dt>Agent ID</dt><dd className="cell-mono">{agent.id}</dd></div><div><dt>模型别名</dt><dd>{agent.modelAlias || "未配置"}</dd></div><div><dt>注册状态</dt><dd>{agent.status}</dd></div><div><dt>事件存储</dt><dd><Database size={15} /> PostgreSQL</dd></div></dl>
          <div className="code-block" aria-label="注册工具">{agent.tools.length ? agent.tools.map((tool) => <span key={tool}>{tool}</span>) : <span>未注册工具</span>}</div>
        </SectionCard>
        <SectionCard title="最近 Runtime 事件" description="未把健康检查 Trace 冒充 Agent 业务运行。">
          {events.length ? <div className="trace-list">{events.map((event) => <Link className="trace-row" href="/observability" key={event.id}><span className="trace-id">{event.id}</span><span>{event.eventType}</span><span>{event.agentId}</span><small>{formatDateTime(event.createdAt)}</small></Link>)}</div> : <div className="empty-data"><strong>暂无运行事件</strong><span>该 Agent 尚未向 runtime_events 写入记录。</span></div>}
        </SectionCard>
      </div>
    </div>
  );
}
