import { ComponentPortal } from "@/components/component-portal";
import { PageHeader } from "@/components/page-header";
import { readConfig } from "@/lib/server/config";
import { checkServices } from "@/lib/server/services";

export const dynamic = "force-dynamic";

export default async function ComponentsPage() {
  const services = await checkServices(await readConfig());

  return (
    <div className="page-stack">
      <PageHeader
        title="组件门户"
        description="在一个入口查看整套 Agent 基础设施，打开专业工作台，并进入 AI Console 的治理与配置页面。"
      />
      <ComponentPortal initialServices={services} />
    </div>
  );
}
