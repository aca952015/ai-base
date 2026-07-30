import { GatewayMcpManager } from "@/components/gateway-mcp-manager";
import { PageHeader } from "@/components/page-header";
import { StatusPill } from "@/components/status-pill";
import { resolveMcpPublicResourceUrl } from "@/lib/control-plane/mcp-client-config";
import { getComponentData } from "@/lib/server/component-data";
import { readConfig } from "@/lib/server/config";
import { readGatewayMcpServers } from "@/lib/server/gateway-config";

export const dynamic = "force-dynamic";

export default async function McpConfigPage() {
  const config = await readConfig();
  const [data, snapshot] = await Promise.all([
    getComponentData(config),
    readGatewayMcpServers(),
  ]);
  const status = data.services.find((service) => service.id === "llm-gateway")?.status || "offline";
  const mcpPublicResource = resolveMcpPublicResourceUrl(
    process.env.MCP_PUBLIC_RESOURCE_URL,
  );

  return (
    <div className="page-stack">
      <PageHeader
        title="MCP配置"
        description="Open Connector 与企业知识库 RAG 默认接入；在这里管理其他 MCP 服务并通过 /mcp 提供统一入口。"
        actions={<StatusPill status={status} />}
      />

      <GatewayMcpManager
        initialServers={snapshot.servers}
        mcpResourceUrl={mcpPublicResource.ok ? mcpPublicResource.url : undefined}
        mcpResourceError={mcpPublicResource.ok ? undefined : mcpPublicResource.error}
      />
    </div>
  );
}
