import { ArrowLeft } from "lucide-react";
import Link from "next/link";

import { PageHeader } from "@/components/page-header";
import { WeComAuthSettingsForm } from "@/components/wecom-auth-settings-form";
import type { WeComAuthenticationSnapshot } from "@/lib/control-plane/types";
import { DEFAULT_WECOM_AUTHENTICATION_RUNTIME_SETTINGS } from "@/lib/server/config";
import { IntegrationStoreError } from "@/lib/server/integrations";
import { getWeComAuthenticationConfiguration } from "@/lib/server/wecom-authentication";

export const dynamic = "force-dynamic";

const emptySnapshot: WeComAuthenticationSnapshot = {
  corpId: "",
  configured: false,
  secretConfigured: false,
  ...DEFAULT_WECOM_AUTHENTICATION_RUNTIME_SETTINGS,
  effectiveCallbackUrl: `${DEFAULT_WECOM_AUTHENTICATION_RUNTIME_SETTINGS.publicBaseUrl}/callback`,
  updatedAt: new Date(0).toISOString(),
};

export default async function WeComAuthenticationPage() {
  const result = await getWeComAuthenticationConfiguration()
    .then((snapshot) => ({ snapshot }))
    .catch((error: unknown) => ({ error }));
  const snapshot = "snapshot" in result ? result.snapshot : emptySnapshot;
  const initialError = "error" in result
    ? result.error instanceof IntegrationStoreError
      ? result.error.message
      : "读取企业微信认证配置失败"
    : undefined;

  return (
    <div className="page-stack">
      <PageHeader
        title="企业微信认证"
        description="维护 AI Base 唯一的企业微信系统认证配置。"
        actions={(
          <Link className="button button--secondary" href="/integrations">
            <ArrowLeft size={16} /> 返回集成管理
          </Link>
        )}
      />
      <WeComAuthSettingsForm initialSnapshot={snapshot} initialError={initialError} />
    </div>
  );
}
