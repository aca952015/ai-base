import { ArrowLeft } from "lucide-react";
import Link from "next/link";

import { LightRagSettingsForm } from "@/components/lightrag-settings-form";
import { PageHeader } from "@/components/page-header";
import { readLightRagConfig } from "@/lib/server/lightrag-config";

export const dynamic = "force-dynamic";

export default async function LightRagSettingsPage() {
  const snapshot = await readLightRagConfig();
  return (
    <div className="page-stack">
      <PageHeader
        title="LightRAG 配置"
        description="从大模型网关选择运行模型，并管理 LightRAG 的索引与并发参数。"
        actions={<Link className="button button--secondary" href="/settings"><ArrowLeft size={16} /> 返回系统设置</Link>}
      />
      <LightRagSettingsForm initialSnapshot={snapshot} />
    </div>
  );
}
