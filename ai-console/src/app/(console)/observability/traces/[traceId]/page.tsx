import { ArrowLeft, ExternalLink } from "lucide-react";
import { notFound } from "next/navigation";

import { PageHeader } from "@/components/page-header";
import { SectionCard } from "@/components/section-card";
import { formatDateTime, formatDuration } from "@/lib/format";
import { requireConsoleAdmin } from "@/lib/server/console-identity";
import { getObservabilityTrace } from "@/lib/server/observability";

export const dynamic = "force-dynamic";

function statusLabel(status: "ok" | "error" | "denied") {
  return status === "ok" ? "成功" : status === "denied" ? "已拒绝" : "错误";
}

export default async function TraceDetailPage({ params }: { params: Promise<{ traceId: string }> }) {
  await requireConsoleAdmin();
  const { traceId } = await params;
  const trace = await getObservabilityTrace(traceId);
  if (!trace) notFound();

  return <div className="page-stack">
    <PageHeader title="Trace 详情" description="仅展示服务端白名单字段；不包含 Prompt、输出、工具参数、返回值或任意 Span events。" actions={<div className="page-actions"><a className="button button--secondary" href="/observability"><ArrowLeft size={15} />返回可观测性</a>{trace.jaegerUrl ? <a className="button button--secondary" href={trace.jaegerUrl} target="_blank" rel="noreferrer">打开受保护的 Jaeger <ExternalLink size={15} /></a> : null}</div>} />
    <SectionCard title={trace.traceId} description={`${formatDateTime(trace.startedAt)} · ${formatDuration(trace.durationMs)} · ${statusLabel(trace.status)}`}>
      <dl className="detail-list detail-list--mono"><div><dt>trace_id</dt><dd>{trace.traceId}</dd></div><div><dt>safe call spans</dt><dd>{trace.calls.length}</dd></div><div><dt>all safe spans</dt><dd>{trace.spans.length}</dd></div><div><dt>Jaeger 深链</dt><dd>{trace.jaegerUrl ? "已启用（管理员保护）" : "未配置受保护地址"}</dd></div></dl>
    </SectionCard>
    <SectionCard title="安全 Span 时间线" description="只保留名称、服务、时间、耗时、状态和少量规范诊断字段。">
      {trace.spans.length ? <div className="table-scroll"><table className="data-table"><thead><tr><th>开始时间</th><th>服务</th><th>Span</th><th>目标</th><th>耗时</th><th>结果</th><th>错误 / 授权原因</th></tr></thead><tbody>{trace.spans.map((span) => <tr key={span.spanId}><td data-label="开始时间">{formatDateTime(span.startedAt)}</td><td data-label="服务">{span.serviceName}</td><td data-label="Span" className="cell-primary">{span.name}</td><td data-label="目标">{span.target ?? "—"}</td><td data-label="耗时" className="cell-mono">{formatDuration(span.durationMs)}</td><td data-label="结果"><span className={`observability-result observability-result--${span.status}`}>{statusLabel(span.status)}</span></td><td data-label="错误 / 授权原因">{span.errorType ?? span.reason ?? "—"}</td></tr>)}</tbody></table></div> : <div className="empty-data"><strong>没有可安全展示的 Span</strong><span>Trace 存在，但白名单适配没有识别到有效 Span。</span></div>}
    </SectionCard>
  </div>;
}
