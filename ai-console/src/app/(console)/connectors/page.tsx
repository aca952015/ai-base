import { ChevronRight, ShieldCheck, UserRound } from "lucide-react";
import Link from "next/link";

import { ConnectorManager } from "@/components/connector-manager";
import { PageHeader } from "@/components/page-header";
import { SectionCard } from "@/components/section-card";
import { StatusPill } from "@/components/status-pill";
import type { ConnectorConnectionsSnapshot, ConnectorProvidersPage } from "@/lib/control-plane/connectors";
import { getComponentData } from "@/lib/server/component-data";
import { readConfig } from "@/lib/server/config";
import { listClassifiedConnectorConnections } from "@/lib/server/integrations";
import { getConnectorProviderSummaries, listConnectorProviders } from "@/lib/server/open-connector";

export const dynamic = "force-dynamic";

const emptyConnections: ConnectorConnectionsSnapshot = {
  connections: [],
  updatedAt: new Date(0).toISOString(),
};

const emptyProviders: ConnectorProvidersPage = {
  items: [],
  total: 0,
  page: 1,
  limit: 24,
  categories: [],
  authTypes: [],
};

export default async function ConnectorsPage() {
  const config = await readConfig();
  const [data, connectionsResult, providersResult] = await Promise.all([
    getComponentData(config),
    listClassifiedConnectorConnections().then((value) => ({ value })).catch((error: unknown) => ({ error })),
    listConnectorProviders({ limit: 24 }).then((value) => ({ value })).catch((error: unknown) => ({ error })),
  ]);
  const connections = "value" in connectionsResult ? connectionsResult.value : emptyConnections;
  const providers = "value" in providersResult ? providersResult.value : emptyProviders;
  const connectionProviders = connections.connections.length
    ? await getConnectorProviderSummaries(connections.connections.map((connection) => connection.service)).catch(() => [])
    : [];
  const initialError = "error" in connectionsResult
    ? connectionsResult.error instanceof Error ? connectionsResult.error.message : "读取连接失败"
    : "error" in providersResult
      ? providersResult.error instanceof Error ? providersResult.error.message : "读取 Connector 目录失败"
      : undefined;
  const status = data.services.find((service) => service.id === "open-connector")?.status || "offline";

  return (
    <div className="page-stack">
      <PageHeader
        title="连接器配置"
        description="管理受控共享和全局连接；认证方式和配置字段实时读取自 OpenConnector。"
        actions={<StatusPill status={status} />}
      />
      <SectionCard title="连接视图" description="员工个人授权形成的连接独立展示，不与管理员维护的系统连接混排。">
        <div className="settings-subpage-list">
          <Link className="settings-subpage-row" href="/connectors/user-connections">
            <span className="settings-subpage-row__icon"><UserRound size={19} /></span>
            <span className="settings-subpage-row__copy"><strong>用户连接</strong><small>员工个人授权、所属账号与可用 Action</small></span>
            <span className="settings-subpage-row__status">{connections.connections.filter((connection) => connection.accessMode === "account_bound").length} 个连接</span>
            <ChevronRight size={18} />
          </Link>
          <Link className="settings-subpage-row" href="/connectors/no-auth">
            <span className="settings-subpage-row__icon is-green"><ShieldCheck size={19} /></span>
            <span className="settings-subpage-row__copy"><strong>无需认证</strong><small>公共数据源、无需凭据的连接与可用 Action</small></span>
            <span className="settings-subpage-row__status">{connections.connections.filter((connection) => connection.accessMode === "no_auth").length} 个连接</span>
            <ChevronRight size={18} />
          </Link>
        </div>
      </SectionCard>
      <ConnectorManager
        initialConnections={connections.connections}
        initialProviders={providers}
        initialConnectionProviders={connectionProviders}
        initialError={initialError}
        view="managed"
      />
    </div>
  );
}
