import { ArrowLeft } from "lucide-react";
import Link from "next/link";

import { ConnectorManager } from "@/components/connector-manager";
import { PageHeader } from "@/components/page-header";
import type { ConnectorConnectionsSnapshot, ConnectorProvidersPage } from "@/lib/control-plane/connectors";
import { listClassifiedConnectorConnections } from "@/lib/server/integrations";
import { getConnectorProviderSummaries } from "@/lib/server/open-connector";

export const dynamic = "force-dynamic";

const emptyConnections: ConnectorConnectionsSnapshot = {
  connections: [],
  updatedAt: new Date(0).toISOString(),
};

const emptyProviders: ConnectorProvidersPage = {
  items: [],
  total: 0,
  page: 1,
  limit: 0,
  categories: [],
  authTypes: [],
};

export default async function UserConnectionsPage() {
  const result = await listClassifiedConnectorConnections()
    .then((value) => ({ value }))
    .catch((error: unknown) => ({ error }));
  const connections = "value" in result ? result.value : emptyConnections;
  const userConnections = connections.connections.filter((connection) => connection.accessMode === "account_bound");
  const connectionProviders = userConnections.length
    ? await getConnectorProviderSummaries(userConnections.map((connection) => connection.service)).catch(() => [])
    : [];
  const initialError = "error" in result
    ? result.error instanceof Error ? result.error.message : "读取用户连接失败"
    : undefined;

  return (
    <div className="page-stack">
      <PageHeader
        title="用户连接"
        description="查看员工通过个人账号授权建立的连接、所属平台账号与可用 Action。"
        actions={<Link className="button button--secondary" href="/connectors"><ArrowLeft size={16} /> 返回连接器配置</Link>}
      />
      <ConnectorManager
        initialConnections={userConnections}
        initialProviders={emptyProviders}
        initialConnectionProviders={connectionProviders}
        initialError={initialError}
        view="user-connections"
      />
    </div>
  );
}
