import { GatewayChannelManager } from "@/components/gateway-channel-manager";
import { PageHeader } from "@/components/page-header";
import { StatusPill } from "@/components/status-pill";
import { getComponentData } from "@/lib/server/component-data";
import { readConfig } from "@/lib/server/config";
import { readGatewayChannels } from "@/lib/server/gateway-config";

export const dynamic = "force-dynamic";

export default async function ModelChannelsPage() {
  const config = await readConfig();
  const [data, gatewaySnapshot] = await Promise.all([
    getComponentData(config),
    readGatewayChannels(),
  ]);
  const status = data.services.find((service) => service.id === "llm-gateway")?.status || "offline";

  return (
    <div className="page-stack">
      <PageHeader
        title="大模型渠道"
        description="集中管理上游服务、服务端密钥和模型别名；Agent 只使用一个兼容 OpenAI 的访问入口。"
        actions={<StatusPill status={status} />}
      />

      <GatewayChannelManager initialChannels={gatewaySnapshot.channels} />
    </div>
  );
}
