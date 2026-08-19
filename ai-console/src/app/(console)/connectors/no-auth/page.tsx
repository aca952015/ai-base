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

export default async function NoAuthConnectionsPage() {
  const result = await listClassifiedConnectorConnections()
    .then((value) => ({ value }))
    .catch((error: unknown) => ({ error }));
  const connections = "value" in result ? result.value : emptyConnections;
  const noAuthConnections = connections.connections.filter((connection) => connection.accessMode === "no_auth");
  const connectionProviders = noAuthConnections.length
    ? await getConnectorProviderSummaries(noAuthConnections.map((connection) => connection.service)).catch(() => [])
    : [];
  const initialError = "error" in result
    ? result.error instanceof Error ? result.error.message : "读取无需认证连接失败"
    : undefined;

  return (
    <div className="page-stack">
      <PageHeader
        title="无需认证"
        description="查看 OpenConnector 提供的公共连接及其可用 Action；这些连接无需管理员维护凭据。"
        actions={<Link className="button button--secondary" href="/connectors"><ArrowLeft size={16} /> 返回连接器配置</Link>}
      />
      <ConnectorManager
        initialConnections={noAuthConnections}
        initialProviders={emptyProviders}
        initialConnectionProviders={connectionProviders}
        initialError={initialError}
        view="no-auth"
      />
    </div>
  );
}
