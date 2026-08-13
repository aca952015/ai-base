import { Activity, Clock3, Coins, ExternalLink, Network, ShieldX, TriangleAlert } from "lucide-react";

import { MetricCard } from "@/components/metric-card";
import { PageHeader } from "@/components/page-header";
import { SectionCard } from "@/components/section-card";
import { formatDateTime, formatDuration, formatNumber, shortId } from "@/lib/format";
import { requireConsoleAdmin } from "@/lib/server/console-identity";
import {
  getObservabilityCalls,
  getObservabilitySummary,
  type MetricValue,
  type ObservabilityCall,
  parseRange,
} from "@/lib/server/observability";

export const dynamic = "force-dynamic";

function metric(metric: MetricValue, suffix = "") {
  return metric.available && metric.value !== null ? `${formatNumber(Math.round(metric.value))}${suffix}` : "不可用";
}

function ratio(metricValue: MetricValue) {
  return metricValue.available && metricValue.value !== null ? `${(metricValue.value * 100).toFixed(1)}%` : "不可用";
}

function callStatus(call: ObservabilityCall) {
  return call.status === "ok" ? "成功" : call.status === "denied" ? "已拒绝" : "错误";
}

function CallsTable({ calls, kind }: { calls: ObservabilityCall[]; kind: "model" | "mcp" }) {
  if (!calls.length) return <div className="empty-data"><strong>时间段内没有诊断样本</strong><span>这不代表完整调用账本；可能尚未产生、导出失败或筛选无结果。</span></div>;
  return (
    <div className="table-scroll">
      <table className="data-table">
        <thead><tr><th>时间</th><th>来源</th><th>{kind === "model" ? "模型" : "Server / Tool"}</th><th>操作</th><th>耗时</th><th>{kind === "model" ? "Token" : "授权"}</th><th>结果</th><th>Trace</th></tr></thead>
        <tbody>{calls.map((call) => <tr key={`${call.traceId}:${call.spanId}`}>
          <td data-label="时间">{formatDateTime(call.startedAt)}</td>
          <td data-label="来源">{call.source}</td>
          <td data-label={kind === "model" ? "模型" : "Server / Tool"} className="cell-primary">{call.target}</td>
          <td data-label="操作">{call.operation}</td>
          <td data-label="耗时" className="cell-mono">{formatDuration(call.durationMs)}</td>
          <td data-label={kind === "model" ? "Token" : "授权"}>{kind === "model" ? (call.totalTokens ?? "上游未返回") : (call.decision ?? "未标注")}</td>
          <td data-label="结果"><span className={`observability-result observability-result--${call.status}`}>{callStatus(call)}</span></td>
          <td data-label="Trace"><a className="text-link trace-id" href={`/observability/traces/${call.traceId}`}>{shortId(call.traceId)}</a></td>
        </tr>)}</tbody>
      </table>
    </div>
  );
}

export default async function ObservabilityPage({ searchParams }: { searchParams: Promise<Record<string, string | string[] | undefined>> }) {
  await requireConsoleAdmin();
  const query = await searchParams;
  const range = parseRange(typeof query.range === "string" ? query.range : null);
  const summary = await getObservabilitySummary(range);
  const to = Date.parse(summary.generatedAt);
  const callWindowMs = range === "15m" ? 15 * 60_000 : range === "1h" ? 60 * 60_000 : 24 * 60 * 60_000;
  const callBase = new URLSearchParams({ from: new Date(to - callWindowMs).toISOString(), to: new Date(to).toISOString(), limit: "50" });
  const modelQuery = new URLSearchParams(callBase); modelQuery.set("kind", "model");
  const mcpQuery = new URLSearchParams(callBase); mcpQuery.set("kind", "mcp");
  const [modelCalls, mcpCalls] = await Promise.all([
    getObservabilityCalls(modelQuery),
    getObservabilityCalls(mcpQuery),
  ]);

  return (
    <div className="page-stack">
      <PageHeader title="可观测性" description="模型与 MCP 的规范指标和安全诊断样本；Trace 不是零丢失账本。" />
      <nav className="observability-ranges" aria-label="观测时间范围">
        {(["15m", "1h", "24h", "7d"] as const).map((item) => <a key={item} className={item === range ? "is-active" : ""} href={`/observability?range=${item}`} aria-current={item === range ? "page" : undefined}>{item}</a>)}
      </nav>
      {summary.partial || modelCalls.source === "offline" || mcpCalls.source === "offline" ? <div className="settings-notice" role="status" aria-live="polite"><TriangleAlert size={18} aria-hidden="true" /><div><strong>部分观测数据不可用</strong><p>{summary.sources.message ?? modelCalls.message ?? mcpCalls.message} 已返回的数据仍可用于诊断。</p></div></div> : null}

      <section className="metric-grid" aria-label="模型调用指标">
        <MetricCard label="模型调用" value={metric(summary.model.calls)} detail={range} trend="Prometheus" icon={Activity} />
        <MetricCard label="模型 P95" value={metric(summary.model.p95LatencyMs, " ms")} detail={range} trend="规范延迟" icon={Clock3} />
        <MetricCard label="输入 Token" value={metric(summary.model.inputTokens)} detail="上游用量" trend="不估算" icon={Coins} />
        <MetricCard label="输出 Token" value={metric(summary.model.outputTokens)} detail="上游用量" trend="不估算" icon={Coins} />
      </section>
      <SectionCard title="模型指标能力边界" description="当前 capability probe 只证明模型调用延迟与 Token 指标。">
        <dl className="detail-list"><div><dt>模型错误率</dt><dd>{metric(summary.model.errorRate)} · {summary.model.errorRate.reason}</dd></div><div><dt>TTFT P95</dt><dd>{metric(summary.model.ttftP95Ms)} · {summary.model.ttftP95Ms.reason}</dd></div></dl>
      </SectionCard>

      <section className="metric-grid" aria-label="MCP 调用指标">
        <MetricCard label="MCP 调用" value={metric(summary.mcp.calls)} detail={range} trend="协议 Span" icon={Network} />
        <MetricCard label="拒绝率" value={ratio(summary.mcp.deniedRate)} detail={range} trend="授权决策" icon={ShieldX} tone={summary.mcp.deniedRate.value ? "warning" : "default"} />
        <MetricCard label="上游/协议错误率" value={ratio(summary.mcp.errorRate)} detail={range} trend="密封结果码" icon={TriangleAlert} />
        <MetricCard label="MCP P95" value={metric(summary.mcp.p95LatencyMs, " ms")} detail={range} trend="协议 Span" icon={Clock3} />
      </section>

      <SectionCard title="模型调用诊断样本" description={`扫描 ${modelCalls.scannedTraces} 条 Trace；最多展示 50 条，诊断搜索窗口最多 24 小时。`}>
        <CallsTable calls={modelCalls.items} kind="model" />
        {modelCalls.truncated ? <p className="observability-truncated" role="status">结果已截断。这是近期诊断样本，不提供稳定 cursor，也不代表完整调用账本。</p> : null}
      </SectionCard>
      <SectionCard title="MCP 调用诊断样本" description={`扫描 ${mcpCalls.scannedTraces} 条 Trace；完整参数、返回值与身份原文不会进入浏览器。`}>
        <CallsTable calls={mcpCalls.items} kind="mcp" />
        {mcpCalls.truncated ? <p className="observability-truncated" role="status">结果已截断。这是近期诊断样本，不提供稳定 cursor，也不代表完整调用账本。</p> : null}
      </SectionCard>
      <p className="observability-footnote"><ExternalLink size={14} aria-hidden="true" /> 深度 waterfall 仅在 Trace 详情中配置了受 Pomerium 管理员保护的 HTTPS Jaeger 地址时提供。</p>
    </div>
  );
}
