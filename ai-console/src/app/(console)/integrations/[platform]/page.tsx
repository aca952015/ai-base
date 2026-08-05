import { ArrowLeft } from "lucide-react";
import Link from "next/link";
import { notFound } from "next/navigation";

import { IntegrationManager } from "@/components/integration-manager";
import { PageHeader } from "@/components/page-header";
import type {
  EnterpriseIntegrationGroup,
  EnterpriseIntegrationsSnapshot,
} from "@/lib/control-plane/integrations";
import { getEnterpriseIntegrations, IntegrationStoreError } from "@/lib/server/integrations";
import { OpenConnectorError } from "@/lib/server/open-connector";

export const dynamic = "force-dynamic";

type ManagedPlatform = "feishu" | "dingtalk";

const platformDetails: Record<ManagedPlatform, Pick<EnterpriseIntegrationGroup, "displayName" | "description">> = {
  feishu: {
    displayName: "飞书",
    description: "管理飞书开放平台应用凭据、OAuth Action 和启用状态。",
  },
  dingtalk: {
    displayName: "钉钉",
    description: "管理钉钉开放平台应用凭据和启用状态。",
  },
};

function isManagedPlatform(value: string): value is ManagedPlatform {
  return value === "feishu" || value === "dingtalk";
}

function emptySnapshot(platform: ManagedPlatform): EnterpriseIntegrationsSnapshot {
  return {
    groups: [{
      platform,
      ...platformDetails[platform],
      actions: [],
      defaultActionIds: [],
      oauthBaseScopes: [],
      applications: [],
    }],
    updatedAt: new Date(0).toISOString(),
  };
}

export default async function EnterpriseIntegrationPlatformPage({
  params,
}: {
  params: Promise<{ platform: string }>;
}) {
  const { platform } = await params;
  if (!isManagedPlatform(platform)) notFound();

  const result = await getEnterpriseIntegrations()
    .then((snapshot) => ({ snapshot }))
    .catch((error: unknown) => ({ error }));
  const snapshot = "snapshot" in result ? result.snapshot : emptySnapshot(platform);
  const initialError = "error" in result
    ? result.error instanceof IntegrationStoreError || result.error instanceof OpenConnectorError
      ? result.error.message
      : `读取${platformDetails[platform].displayName}集成配置失败`
    : undefined;

  return (
    <div className="page-stack">
      <PageHeader
        title={`${platformDetails[platform].displayName}配置`}
        description={platformDetails[platform].description}
        actions={(
          <Link className="button button--secondary" href="/integrations">
            <ArrowLeft size={16} /> 返回集成管理
          </Link>
        )}
      />
      <IntegrationManager
        initialSnapshot={snapshot}
        initialError={initialError}
        platform={platform}
      />
    </div>
  );
}
