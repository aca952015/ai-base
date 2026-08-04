import { ArrowLeft } from "lucide-react";
import Link from "next/link";

import { PageHeader } from "@/components/page-header";
import { WeComAuthSettingsForm } from "@/components/wecom-auth-settings-form";
import { getWeComAuthenticationSnapshot, readConfig } from "@/lib/server/config";

export const dynamic = "force-dynamic";

export default async function WeComAuthSettingsPage() {
  const snapshot = getWeComAuthenticationSnapshot(await readConfig());
  return (
    <div className="page-stack">
      <PageHeader
        title="企业微信认证"
        description="管理 AI Base 的公开认证入口、企业微信回调方式和员工邮箱域。"
        actions={<Link className="button button--secondary" href="/settings"><ArrowLeft size={16} /> 返回系统设置</Link>}
      />
      <WeComAuthSettingsForm initialSnapshot={snapshot} />
    </div>
  );
}
