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
  const postgresStatus = data.services.find((service) => service.id === "postgres")?.status || "offline";
  const processedCount = data.knowledge.statusCounts.processed || 0;

  return (
    <div className="page-stack">
      <PageHeader title="数据与知识" description="LightRAG 管理文档、混合检索和知识图谱，索引数据统一存储在 PostgreSQL。" />
      <section className="metric-grid" aria-label="知识与数据指标">
        <MetricCard label="知识文档" value={formatNumber(data.knowledge.documentCount)} detail={`${processedCount} 篇已完成索引`} trend={data.knowledge.pipelineBusy ? "索引处理中" : "LightRAG"} icon={FileText} />
        <MetricCard label="文本体积" value={formatBytes(data.knowledge.totalBytes)} detail="来自 LightRAG 文档状态" trend="不返回正文" icon={HardDrive} />
        <MetricCard label="pgvector" value={data.runtime.pgvector} detail={data.runtime.database} trend="扩展版本" icon={Database} tone={data.runtime.pgvector === "missing" ? "warning" : "positive"} />
        <MetricCard label="数据库大小" value={formatBytes(data.runtime.databaseSizeBytes)} detail="共享知识与运行数据" trend="PostgreSQL + AGE" icon={Server} />
      </section>
      <SectionCard id="knowledge" title="LightRAG 文档" description="展示索引状态、切片数量和更新时间，不向浏览器返回知识正文。" action={<a className="section-link" href="http://knowledge.localhost:8080/webui" target="_blank" rel="noreferrer">打开 LightRAG <ArrowRight size={14} /></a>}>
        {data.knowledge.documents.length ? <div className="table-scroll"><table className="data-table"><thead><tr><th>文档</th><th>路径</th><th>内容大小</th><th>切片</th><th>状态</th><th>最后修改</th></tr></thead><tbody>{data.knowledge.documents.map((document) => <tr key={document.relativePath}><td data-label="文档"><strong>{document.name}</strong></td><td data-label="路径" className="cell-mono">{document.relativePath}</td><td data-label="内容大小" className="cell-mono">{formatBytes(document.sizeBytes)}</td><td data-label="切片">{formatNumber(document.chunksCount)}</td><td data-label="状态" className="cell-mono">{document.status}</td><td data-label="最后修改">{formatDateTime(document.modifiedAt)}</td></tr>)}</tbody></table></div> : <div className="empty-data"><strong>知识库暂无文档</strong><span>在 LightRAG 上传文档，或点击“同步知识”扫描输入目录。</span></div>}
      </SectionCard>
      <div className="dashboard-grid dashboard-grid--equal">
        <SectionCard title="索引管线" description="文档状态来自 LightRAG，存储能力来自共享 PostgreSQL。">
          <ol className="pipeline-list"><li className="is-complete"><span>1</span><div><strong>文档读取与分块</strong><small>{data.knowledge.documentCount} 篇 · {formatDateTime(data.knowledge.latestModifiedAt)}</small></div></li><li className="is-complete"><span>2</span><div><strong>Embedding 与向量索引</strong><small>Envoy AI Gateway · pgvector {data.runtime.pgvector}</small></div></li><li className="is-complete"><span>3</span><div><strong>实体关系抽取</strong><small>大模型网关 qwen 路由</small></div></li><li className="is-complete"><span>4</span><div><strong>知识图谱</strong><small>PostgreSQL Apache AGE</small></div></li></ol>
        </SectionCard>
        <SectionCard title="PostgreSQL 状态" description="控制面、向量和图数据复用同一数据库基础设施。">
          <div className="database-hero"><span><Server size={24} /></span><div><strong>PostgreSQL + pgvector + AGE</strong><p>{formatBytes(data.runtime.databaseSizeBytes)} · {data.runtime.eventCount} 条 Runtime 事件</p></div><StatusPill status={postgresStatus} compact /></div>
          <dl className="detail-list"><div><dt>数据库状态</dt><dd>{data.runtime.database}</dd></div><div><dt>pgvector 版本</dt><dd className="cell-mono">{data.runtime.pgvector}</dd></div><div><dt>Apache AGE 版本</dt><dd className="cell-mono">{data.runtime.apacheAge}</dd></div><div><dt>知识索引</dt><dd><ShieldCheck size={15} /> {processedCount} 篇已完成</dd></div></dl>
          <Link className="text-link" href="/settings#service-postgres">查看数据配置</Link>
        </SectionCard>
      </div>
    </div>
  );
}
