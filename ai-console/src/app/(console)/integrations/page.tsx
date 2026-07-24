import { IntegrationManager } from "@/components/integration-manager";
import { PageHeader } from "@/components/page-header";
import type { EnterpriseIntegrationsSnapshot } from "@/lib/control-plane/integrations";
import { getEnterpriseIntegrations, IntegrationStoreError } from "@/lib/server/integrations";
import { OpenConnectorError } from "@/lib/server/open-connector";

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
      platform: "wecom",
      displayName: "企微",
      description: "管理企微自建应用凭据。",
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
  const result = await getEnterpriseIntegrations()
    .then((snapshot) => ({ snapshot }))
    .catch((error: unknown) => ({ error }));
  const snapshot = "snapshot" in result ? result.snapshot : emptySnapshot;
  const initialError = "error" in result
    ? result.error instanceof IntegrationStoreError || result.error instanceof OpenConnectorError
      ? result.error.message
      : "读取企业集成失败"
    : undefined;

  return (
    <div className="page-stack">
      <PageHeader
        title="集成管理"
        description="按平台管理企业应用凭据和开放给员工的 Action 权限。"
      />
      <IntegrationManager initialSnapshot={snapshot} initialError={initialError} />
    </div>
  );
}
