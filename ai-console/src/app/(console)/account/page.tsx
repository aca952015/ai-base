import { AccountIntegrationManager } from "@/components/account-integration-manager";
import { PageHeader } from "@/components/page-header";

export const dynamic = "force-dynamic";

export default async function AccountPage({
  searchParams,
}: {
  searchParams: Promise<{ wecom_link?: string | string[] }>;
}) {
  const query = await searchParams;
  const wecomLinkResult = typeof query.wecom_link === "string" ? query.wecom_link : undefined;
  return (
    <div className="page-stack">
      <PageHeader
        title="账号绑定"
        description="维护个人 OAuth 账号，并将可信企业微信身份关联到当前平台账号。"
      />
      <AccountIntegrationManager wecomLinkResult={wecomLinkResult} />
    </div>
  );
}
