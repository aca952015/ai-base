import { AccountIntegrationManager } from "@/components/account-integration-manager";
import { PageHeader } from "@/components/page-header";

export const dynamic = "force-dynamic";

export default function AccountPage() {
  return (
    <div className="page-stack">
      <PageHeader
        title="账号绑定"
        description="维护个人 OAuth 账号；企业共享机器人会在 MCP 登录后按可信企微身份自动筛选。"
      />
      <AccountIntegrationManager />
    </div>
  );
}
