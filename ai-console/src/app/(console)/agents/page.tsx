import { Activity, Bot, Braces, CircleCheck } from "lucide-react";

import { AgentTable } from "@/components/agent-table";
import { MetricCard } from "@/components/metric-card";
import { PageHeader } from "@/components/page-header";
import { SectionCard } from "@/components/section-card";
import { formatNumber } from "@/lib/format";
import { getComponentData } from "@/lib/server/component-data";
import { readConfig } from "@/lib/server/config";

export const dynamic = "force-dynamic";

export default async function AgentsPage() {
  const { runtime } = await getComponentData(await readConfig());
  const readyAgents = runtime.agents.filter((agent) => agent.status === "ready").length;
  const activeAgents = runtime.agents.filter((agent) => agent.runCount > 0).length;
  const toolCount = new Set(runtime.agents.flatMap((agent) => agent.tools)).size;

  return (
    <div className="page-stack">
      <PageHeader title="Agent 管理" description="Agent 注册信息来自 Runtime，运行次数和最近活动来自 PostgreSQL 实际事件。" />
      <section className="metric-grid" aria-label="Agent 状态摘要">
        <MetricCard label="已注册" value={formatNumber(readyAgents)} detail="Runtime 配置" trend="实时读取" icon={CircleCheck} tone="positive" />
        <MetricCard label="有运行记录" value={formatNumber(activeAgents)} detail="runtime_events" trend={`${runtime.eventCount} 条事件`} icon={Activity} />
        <MetricCard label="唯一工具" value={formatNumber(toolCount)} detail="注册工具标识" trend="Runtime" icon={Braces} />
        <MetricCard label="pgvector" value={runtime.pgvector} detail={runtime.database} trend="PostgreSQL" icon={Bot} />
      </section>
      <SectionCard title="全部 Agent" description="尚未接入的成功率、延迟和评测数据不会用演示值填充。"><AgentTable agents={runtime.agents} /></SectionCard>
      <div className="info-panel"><span className="info-panel__icon" aria-hidden="true"><Bot size={19} /></span><div><strong>数据来源</strong><p>配置来自 Agent Runtime `/v1/agents`，事件聚合来自 PostgreSQL `runtime_events`。</p></div></div>
    </div>
  );
}
