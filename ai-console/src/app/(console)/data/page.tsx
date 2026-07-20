import { ArrowRight, Database, FileText, HardDrive, Server, ShieldCheck } from "lucide-react";
import Link from "next/link";

import { MetricCard } from "@/components/metric-card";
import { PageHeader } from "@/components/page-header";
import { SectionCard } from "@/components/section-card";
import { StatusPill } from "@/components/status-pill";
import { formatBytes, formatDateTime, formatNumber } from "@/lib/format";
import { getComponentData } from "@/lib/server/component-data";
import { readConfig } from "@/lib/server/config";

export const dynamic = "force-dynamic";

export default async function DataPage() {
  const data = await getComponentData(await readConfig());
  const knowledgeStatus = data.services.find((service) => service.id === "silverbullet")?.status || "offline";
  const postgresStatus = data.services.find((service) => service.id === "postgres")?.status || "offline";

  return (
    <div className="page-stack">
      <PageHeader eyebrow="Markdown source of truth" title="数据与知识" description="SilverBullet 文件元数据来自只读 Space，数据库指标来自 Agent Runtime 与 PostgreSQL。" />
      <section className="metric-grid" aria-label="知识与数据指标">
        <MetricCard label="知识文档" value={formatNumber(data.knowledge.documentCount)} detail="实际 Markdown 文件" trend="SilverBullet" icon={FileText} />
        <MetricCard label="知识体积" value={formatBytes(data.knowledge.totalBytes)} detail="不读取正文到浏览器" trend="只读挂载" icon={HardDrive} />
        <MetricCard label="pgvector" value={data.runtime.pgvector} detail={data.runtime.database} trend="扩展版本" icon={Database} tone={data.runtime.pgvector === "missing" ? "warning" : "positive"} />
        <MetricCard label="数据库大小" value={formatBytes(data.runtime.databaseSizeBytes)} detail="pg_database_size" trend="PostgreSQL" icon={Server} />
      </section>
      <SectionCard title="SilverBullet 文档" description="仅展示路径、大小与更新时间，不默认读取知识正文。" action={<a className="section-link" href="http://knowledge.localhost:8080" target="_blank" rel="noreferrer">打开 SilverBullet <ArrowRight size={14} /></a>}>
        {data.knowledge.documents.length ? <div className="table-scroll"><table className="data-table"><thead><tr><th>文档</th><th>相对路径</th><th>大小</th><th>最后修改</th><th>状态</th></tr></thead><tbody>{data.knowledge.documents.map((document) => <tr key={document.relativePath}><td data-label="文档"><strong>{document.name}</strong></td><td data-label="相对路径" className="cell-mono">{document.relativePath}</td><td data-label="大小" className="cell-mono">{formatBytes(document.sizeBytes)}</td><td data-label="最后修改">{formatDateTime(document.modifiedAt)}</td><td data-label="状态"><StatusPill status={knowledgeStatus} compact /></td></tr>)}</tbody></table></div> : <div className="empty-data"><strong>知识空间暂无 Markdown</strong><span>在 SilverBullet 新建文档后会显示在这里。</span></div>}
      </SectionCard>
      <div className="dashboard-grid dashboard-grid--equal">
        <SectionCard title="索引管线" description="只显示已经建成的步骤；未实现的 RAG 索引明确标记为未配置。">
          <ol className="pipeline-list"><li className="is-complete"><span>1</span><div><strong>读取 Markdown 元数据</strong><small>{data.knowledge.documentCount} 篇 · {formatDateTime(data.knowledge.latestModifiedAt)}</small></div></li><li className="is-complete"><span>2</span><div><strong>PostgreSQL / pgvector</strong><small>扩展 {data.runtime.pgvector}</small></div></li><li><span>3</span><div><strong>分块与 Embedding</strong><small>尚未接入，不显示虚构切片</small></div></li><li><span>4</span><div><strong>全文 / 向量索引</strong><small>尚未配置</small></div></li></ol>
        </SectionCard>
        <SectionCard title="PostgreSQL 状态" description="指标通过 Runtime 的受限接口读取。">
          <div className="database-hero"><span><Server size={24} /></span><div><strong>PostgreSQL + pgvector {data.runtime.pgvector}</strong><p>{formatBytes(data.runtime.databaseSizeBytes)} · {data.runtime.eventCount} 条 Runtime 事件</p></div><StatusPill status={postgresStatus} compact /></div>
          <dl className="detail-list"><div><dt>数据库状态</dt><dd>{data.runtime.database}</dd></div><div><dt>pgvector 版本</dt><dd className="cell-mono">{data.runtime.pgvector}</dd></div><div><dt>Runtime 事件</dt><dd>{formatNumber(data.runtime.eventCount)}</dd></div><div><dt>知识索引</dt><dd><ShieldCheck size={15} /> 未配置，不伪造</dd></div></dl>
          <Link className="text-link" href="/settings#service-postgres">查看数据配置</Link>
        </SectionCard>
      </div>
    </div>
  );
}
