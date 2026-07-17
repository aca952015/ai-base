import { Activity, Box, ExternalLink, Gauge, Network, TriangleAlert } from "lucide-react";

import { MetricCard } from "@/components/metric-card";
import { PageHeader } from "@/components/page-header";
import { SectionCard } from "@/components/section-card";
import { StatusPill } from "@/components/status-pill";
import { formatDateTime, formatDuration, formatNumber, shortId } from "@/lib/format";
import { getComponentData } from "@/lib/server/component-data";
import { readConfig } from "@/lib/server/config";

export const dynamic = "force-dynamic";

export default async function ObservabilityPage() {
  const { tracing } = await getComponentData(await readConfig());
  const latest = tracing.traces[0];

  return (
    <div className="page-stack">
      <PageHeader eyebrow="OpenTelemetry · Jaeger" title="可观测性" description="近期 Trace、Span、延迟与状态直接来自 Jaeger 查询适配层。" actions={<a className="button button--secondary" href="http://localhost:16686" target="_blank" rel="noreferrer">打开 Jaeger <ExternalLink size={15} /></a>} />
      <section className="metric-grid" aria-label="可观测指标">
        <MetricCard label="最近 Trace" value={formatNumber(tracing.recentTraceCount)} detail="查询上限 100" trend="Jaeger" icon={Activity} />
        <MetricCard label="Span 数" value={formatNumber(tracing.spanCount)} detail="当前查询结果" trend="OpenTelemetry" icon={Box} />
        <MetricCard label="错误 Trace" value={formatNumber(tracing.errorTraceCount)} detail="HTTP ≥ 400 或 error=true" trend="白名单标签" icon={TriangleAlert} tone={tracing.errorTraceCount ? "warning" : "positive"} />
        <MetricCard label="服务数" value={formatNumber(tracing.serviceCount)} detail="Jaeger service registry" trend="实时" icon={Network} />
      </section>
      {latest ? <div className="dashboard-grid dashboard-grid--wide"><SectionCard className="grid-span-2" title="最新 Trace" description={`${shortId(latest.traceId)} · ${latest.operationName}`}><div className="trace-waterfall"><div className={latest.status === "degraded" ? "trace-step is-warning" : "trace-step"}><div><Gauge size={15} /><strong>{latest.serviceName}</strong><span>{latest.spanCount} spans · {formatDuration(latest.durationMs)}</span></div><div className="trace-bar-track"><span style={{ width: "100%" }} /></div></div></div></SectionCard><SectionCard title="Trace 摘要" description="不转发 Prompt、输出或任意 Span 日志。"><dl className="detail-list detail-list--mono"><div><dt>trace_id</dt><dd>{shortId(latest.traceId)}</dd></div><div><dt>service</dt><dd>{latest.serviceName}</dd></div><div><dt>operation</dt><dd>{latest.operationName}</dd></div><div><dt>started</dt><dd>{formatDateTime(latest.startedAt)}</dd></div><div><dt>duration</dt><dd>{formatDuration(latest.durationMs)}</dd></div></dl></SectionCard></div> : <div className="empty-data"><strong>Jaeger 暂无 Trace</strong><span>服务产生 OpenTelemetry Trace 后会显示在这里。</span></div>}
      <SectionCard title="最近 Trace" description="数据来自 Jaeger `/api/traces`；健康检查 Trace 会如实显示，不冒充业务调用。">
        {tracing.traces.length ? <div className="table-scroll"><table className="data-table"><thead><tr><th>Trace ID</th><th>服务</th><th>操作</th><th>Span</th><th>耗时</th><th>结果</th><th>开始时间</th></tr></thead><tbody>{tracing.traces.slice(0, 20).map((trace) => <tr key={trace.traceId}><td data-label="Trace ID" className="trace-id">{shortId(trace.traceId)}</td><td data-label="服务">{trace.serviceName}</td><td data-label="操作">{trace.operationName}</td><td data-label="Span" className="cell-mono">{trace.spanCount}</td><td data-label="耗时" className="cell-mono">{formatDuration(trace.durationMs)}</td><td data-label="结果"><StatusPill status={trace.status} compact /></td><td data-label="开始时间">{formatDateTime(trace.startedAt)}</td></tr>)}</tbody></table></div> : <div className="empty-data"><strong>暂无 Trace</strong><span>当前查询没有返回记录。</span></div>}
        <a className="text-link" href="http://localhost:16686" target="_blank" rel="noreferrer">在 Jaeger 中继续分析</a>
      </SectionCard>
    </div>
  );
}
