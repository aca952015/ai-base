import { McpClientSetupGuide } from "@/components/mcp-client-setup-guide";
import { PageHeader } from "@/components/page-header";
import { resolveMcpPublicResourceUrl } from "@/lib/control-plane/mcp-client-config";

export const dynamic = "force-dynamic";

export default function ClientSetupPage() {
  const mcpPublicResource = resolveMcpPublicResourceUrl(
    process.env.MCP_PUBLIC_RESOURCE_URL,
  );

  return (
    <div className="page-stack">
      <PageHeader
        title="配置指南"
        description="复制通用 MCP 配置，或切换到常用客户端查看对应的接入方式。"
      />
      <McpClientSetupGuide
        resourceUrl={mcpPublicResource.ok ? mcpPublicResource.url : undefined}
        resourceError={mcpPublicResource.ok ? undefined : mcpPublicResource.error}
      />
    </div>
  );
}
