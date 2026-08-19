import { Building2, ChevronRight, MessageSquareShare, ShieldCheck } from "lucide-react";
import Link from "next/link";

import { PageHeader } from "@/components/page-header";
import { SectionCard } from "@/components/section-card";
import type { EnterpriseIntegrationsSnapshot } from "@/lib/control-plane/integrations";
import { getEnterpriseIntegrations } from "@/lib/server/integrations";
import { getWeComAuthenticationConfiguration } from "@/lib/server/wecom-authentication";

export const dynamic = "force-dynamic";

const emptySnapshot: EnterpriseIntegrationsSnapshot = {
  groups: [
    {
      platform: "feishu",
      displayName: "飞书",
      description: "管理飞书开放平台应用凭据。",
      actions: [],
      defaultActionIds: [],
      oauthBaseScopes: [],
      applications: [],
    },
    {
      platform: "dingtalk",
      displayName: "钉钉",
      description: "管理钉钉开放平台应用凭据。",
      actions: [],
      defaultActionIds: [],
      oauthBaseScopes: [],
      applications: [],
    },
  ],
  updatedAt: new Date(0).toISOString(),
};

export default async function IntegrationsPage() {
  const [result, wecomResult] = await Promise.all([
    getEnterpriseIntegrations()
      .then((snapshot) => ({ snapshot }))
      .catch((error: unknown) => ({ error })),
    getWeComAuthenticationConfiguration()
      .then((snapshot) => ({ snapshot }))
      .catch((error: unknown) => ({ error })),
  ]);
  const snapshot = "snapshot" in result ? result.snapshot : emptySnapshot;
  const enterpriseReadFailed = "error" in result;
  const wecomStatus = "snapshot" in wecomResult
    ? wecomResult.snapshot.configuredCount
      ? `已配置 · ${wecomResult.snapshot.configuredCount} 个组织`
      : "未配置"
    : "读取失败";
  const platformStatus = (platform: "feishu" | "dingtalk") => {
    if (enterpriseReadFailed) return "读取失败";
    const applications = snapshot.groups.find((group) => group.platform === platform)?.applications ?? [];
    if (applications.length === 0) return "未配置";
    return `${applications.some((application) => application.active) ? "已启用" : "未启用"} · ${applications.length} 个应用`;
  };

  return (
    <div className="page-stack">
      <PageHeader
        title="集成管理"
        description="管理企业微信系统认证与个人 OAuth 应用；共享机器人凭据请在连接器管理中维护。"
      />
      <SectionCard title="企业集成配置" description="每个平台进入独立二级页面维护凭据、权限与启用状态。">
        <div className="settings-subpage-list">
          <Link className="settings-subpage-row" href="/integrations/wecom-authentication">
            <span className="settings-subpage-row__icon is-green"><Building2 size={19} /></span>
            <span className="settings-subpage-row__copy">
              <strong>企业微信认证</strong>
              <small>CorpID、App Secret、认证入口与回调</small>
            </span>
            <span className="settings-subpage-row__status">{wecomStatus}</span>
            <ChevronRight size={18} />
          </Link>
          <Link className="settings-subpage-row" href="/integrations/feishu">
            <span className="settings-subpage-row__icon integration-icon--feishu"><MessageSquareShare size={19} /></span>
            <span className="settings-subpage-row__copy">
              <strong>飞书</strong>
              <small>应用凭据、OAuth Action 与启用状态</small>
            </span>
            <span className="settings-subpage-row__status">{platformStatus("feishu")}</span>
            <ChevronRight size={18} />
          </Link>
          <Link className="settings-subpage-row" href="/integrations/dingtalk">
            <span className="settings-subpage-row__icon integration-icon--dingtalk"><ShieldCheck size={19} /></span>
            <span className="settings-subpage-row__copy">
              <strong>钉钉</strong>
              <small>应用凭据与启用状态</small>
            </span>
            <span className="settings-subpage-row__status">{platformStatus("dingtalk")}</span>
            <ChevronRight size={18} />
          </Link>
        </div>
      </SectionCard>
    </div>
  );
}
