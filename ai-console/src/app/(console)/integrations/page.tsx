import { IntegrationManager } from "@/components/integration-manager";
import { PageHeader } from "@/components/page-header";
import type { EnterpriseIntegrationsSnapshot } from "@/lib/control-plane/integrations";
import { getEnterpriseIntegrations, IntegrationStoreError } from "@/lib/server/integrations";

export const dynamic = "force-dynamic";

const emptySnapshot: EnterpriseIntegrationsSnapshot = {
  groups: [
    {
      platform: "feishu",
      displayName: "飞书",
      description: "管理飞书开放平台应用凭据。",
      applications: [],
    },
    {
      platform: "wecom",
      displayName: "企微",
      description: "管理企微自建应用凭据。",
      applications: [],
    },
    {
      platform: "dingtalk",
      displayName: "钉钉",
      description: "管理钉钉开放平台应用凭据。",
      applications: [],
    },
  ],
  updatedAt: new Date(0).toISOString(),
};

export default async function IntegrationsPage() {
  const result = await getEnterpriseIntegrations()
    .then((snapshot) => ({ snapshot }))
    .catch((error: unknown) => ({ error }));
  const snapshot = "snapshot" in result ? result.snapshot : emptySnapshot;
  const initialError = "error" in result
    ? result.error instanceof IntegrationStoreError
      ? result.error.message
      : "读取企业集成失败"
    : undefined;

  return (
    <div className="page-stack">
      <PageHeader
        title="集成管理"
        description="按飞书、企微、钉钉分组管理应用名称、凭据和备注。"
      />
      <IntegrationManager initialSnapshot={snapshot} initialError={initialError} />
    </div>
  );
}
