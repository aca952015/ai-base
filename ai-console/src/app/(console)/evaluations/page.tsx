import { CircleDashed, FlaskConical, GitPullRequest, ShieldAlert, Target } from "lucide-react";

import { MetricCard } from "@/components/metric-card";
import { PageHeader } from "@/components/page-header";
import { QuickActions } from "@/components/quick-actions";
import { SectionCard } from "@/components/section-card";
import { StatusPill } from "@/components/status-pill";
import { getComponentData } from "@/lib/server/component-data";
import { readConfig } from "@/lib/server/config";

export const dynamic = "force-dynamic";

export default async function EvaluationsPage() {
  const { evaluation } = await getComponentData(await readConfig());
  const running = evaluation.status === "running";

  return (
    <div className="page-stack">
      <PageHeader title="质量评测" description="只展示已经取得的 Promptfoo 运行状态和结果；没有结果时保持真实空状态。" actions={<QuickActions />} />
      <section className="metric-grid" aria-label="评测指标">
        <MetricCard label="运行状态" value={running ? "运行中" : "按需"} detail={evaluation.detail} trend="Promptfoo" icon={FlaskConical} />
        <MetricCard label="已接入结果" value={String(evaluation.resultCount)} detail="尚未配置结果导出" trend="真实计数" icon={Target} />
        <MetricCard label="发布结论" value="暂无" detail="没有评测结果" trend="未判定" icon={GitPullRequest} />
        <MetricCard label="安全套件" value="暂无" detail="没有 CI 产物" trend="未接入" icon={ShieldAlert} />
      </section>
      <SectionCard title="评测结果" description="此前的演示套件、通过率和发布告警已移除。">
        <div className="empty-data empty-data--large"><span><CircleDashed size={24} /></span><strong>尚无真实 Promptfoo 结果</strong><p>启动 quality profile 或由 CI 运行评测后，再接入经过脱敏的结果摘要。当前不会显示虚构通过率。</p><StatusPill status={running ? "healthy" : "idle"} /></div>
      </SectionCard>
      <SectionCard title="运行原则" description="Promptfoo 按需执行，不进入默认常驻运行面。"><div className="principle-block"><span><FlaskConical size={22} /></span><div><strong>结果必须可追溯</strong><p>完整断言、样例和差异保留在代码仓库与 CI 产物中；Console 只接收真实运行摘要。</p></div></div></SectionCard>
    </div>
  );
}
