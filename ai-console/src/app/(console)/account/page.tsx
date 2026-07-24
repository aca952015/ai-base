import { AccountIntegrationManager } from "@/components/account-integration-manager";
import { PageHeader } from "@/components/page-header";

export const dynamic = "force-dynamic";

export default function AccountPage() {
  return (
    <div className="page-stack">
      <PageHeader
        title="账号绑定"
        description="绑定个人企业账号，AI Base 将按当前登录身份建立并筛选专属连接器。"
      />
      <AccountIntegrationManager />
    </div>
  );
}
