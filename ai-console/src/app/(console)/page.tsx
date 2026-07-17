import { Activity, Bot, BrainCircuit, CircleCheck, Database, Network, NotebookTabs, ShieldAlert } from "lucide-react";
import Link from "next/link";

import { AgentTable } from "@/components/agent-table";
import { LiveServiceTable } from "@/components/live-service-table";
import { MetricCard } from "@/components/metric-card";
import { PageHeader } from "@/components/page-header";
import { PortalQuickLinks } from "@/components/portal-quick-links";
import { QuickActions } from "@/components/quick-actions";
import { SectionCard } from "@/components/section-card";
import { formatBytes, formatDateTime, formatNumber } from "@/lib/format";
import { getComponentData } from "@/lib/server/component-data";
import { readConfig } from "@/lib/server/config";

export const dynamic = "force-dynamic";

export default async function DashboardPage() {
  const data = await getComponentData(await readConfig());
  const healthyCount = data.services.filter((service) => service.status === "healthy").length;
  const issueServices = data.services.filter((service) => ["degraded", "offline", "unconfigured"].includes(service.status));

  return (
    <div className="page-stack">
      <PageHeader
        eyebrow={`真实组件数据 · ${formatDateTime(data.generatedAt)}`}
        title="控制台总览"
        description="直接汇总 Agent Runtime、Envoy AI Gateway、OpenConnector、SilverBullet、PostgreSQL 与 Jaeger 的实际数据。"
        actions={<QuickActions />}
      />

      {issueServices.length > 0 ? (
        <div className="attention-strip" role="alert">
          <span className="attention-strip__icon" aria-hidden="true"><ShieldAlert size={18} /></span>
          <div><strong>{issueServices.length} 个组件需要处理</strong><span>{issueServices.map((service) => service.name).join("、")}</span></div>
          <Link href="/components">查看组件</Link>
        </div>
      ) : (
        <div className="health-strip" role="status"><CircleCheck size={18} /><div><strong>常驻组件均可用</strong><span>{healthyCount} 个组件健康，{data.services.length - healthyCount} 个按需或非健康状态。</span></div></div>
      )}

      <PortalQuickLinks />

      <section className="metric-grid" aria-label="真实运行指标">
        <MetricCard label="健康组件" value={`${healthyCount}/${data.services.length}`} detail="实时 HTTP/TCP 探测" trend={issueServices.length ? `${issueServices.length} 项异常` : "无异常"} icon={CircleCheck} tone="positive" />
        <MetricCard label="Runtime 事件" value={formatNumber(data.runtime.eventCount)} detail={`${data.runtime.agents.length} 个注册或观测 Agent`} trend="PostgreSQL" icon={Bot} />
        <MetricCard label="网关模型" value={formatNumber(data.modelGateway.modelCount)} detail={`${data.modelGateway.channelCount} 个启用渠道`} trend="Envoy AI Gateway" icon={BrainCircuit} />
        <MetricCard label="Jaeger Trace" value={formatNumber(data.tracing.recentTraceCount)} detail="最近查询，含健康检查" trend={`${data.tracing.errorTraceCount} 个错误`} icon={Activity} tone={data.tracing.errorTraceCount ? "warning" : "positive"} />
      </section>

      <SectionCard title="基础服务" description="服务端直接探测配置端点；刷新结果不会使用演示回退。" action={<Link className="section-link" href="/settings">管理端点</Link>}>
        <LiveServiceTable initialServices={data.services} />
      </SectionCard>

      <section className="real-data-grid" aria-label="组件真实摘要">
        <article><span><BrainCircuit size={18} /></span><div><strong>Envoy AI Gateway</strong><p>{data.modelGateway.channelCount} 个渠道，{data.modelGateway.modelCount} 个已发布模型；渠道由 Console 管理</p></div></article>
        <article><span><Network size={18} /></span><div><strong>OpenConnector</strong><p>{formatNumber(data.connector.providerCount)} 个 Provider，{data.connector.connectionCount} 个连接，{data.connector.authenticatedAppCount} 个认证连接</p></div></article>
        <article><span><NotebookTabs size={18} /></span><div><strong>SilverBullet</strong><p>{data.knowledge.documentCount} 篇 Markdown，合计 {formatBytes(data.knowledge.totalBytes)}</p></div></article>
        <article><span><Database size={18} /></span><div><strong>PostgreSQL</strong><p>pgvector {data.runtime.pgvector}，数据库 {formatBytes(data.runtime.databaseSizeBytes)}</p></div></article>
      </section>

      <SectionCard title="Agent Runtime 注册表" description="只显示 Runtime 返回的注册配置和 PostgreSQL 中的实际事件。" action={<Link className="section-link" href="/agents">查看全部</Link>}>
        <AgentTable agents={data.runtime.agents} limit={3} />
      </SectionCard>

      <SectionCard title="最近 Runtime 事件" description="数据直接来自 PostgreSQL runtime_events；无事件时显示空状态。">
        {data.runtime.recentEvents.length ? (
          <ol className="activity-list">
            {data.runtime.recentEvents.slice(0, 8).map((event) => (
              <li key={event.id}><span className="activity-mark activity-mark--sync" aria-hidden="true" /><div><strong>{event.eventType}</strong><p className="cell-mono">{event.agentId} · {event.id}</p><small>{formatDateTime(event.createdAt)}</small></div></li>
            ))}
          </ol>
        ) : <div className="empty-data"><strong>暂无 Runtime 事件</strong><span>实际运行写入 PostgreSQL 后会出现在这里。</span></div>}
      </SectionCard>
    </div>
  );
}
