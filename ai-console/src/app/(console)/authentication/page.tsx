import {
  Activity,
  Fingerprint,
  KeyRound,
  MonitorSmartphone,
  ShieldCheck,
} from "lucide-react";

import { MetricCard } from "@/components/metric-card";
import { PageHeader } from "@/components/page-header";
import { SectionCard } from "@/components/section-card";
import { formatDateTime, formatNumber, shortId } from "@/lib/format";
import { getComponentData } from "@/lib/server/component-data";
import { readConfig } from "@/lib/server/config";

export const dynamic = "force-dynamic";

function identityName(client: {
  displayName?: string;
  email?: string;
  subjectFingerprint: string;
}) {
  return client.displayName || client.email || client.subjectFingerprint;
}

export default async function AuthenticationPage() {
  const { authentication, errors } = await getComponentData(await readConfig());
  const retentionHours = Math.round(authentication.retentionSeconds / 3_600);
  const activeMinutes = Math.round(authentication.activeWindowSeconds / 60);

  return (
    <div className="page-stack">
      <PageHeader
        title="认证管理"
        description="查看通过 MCP Access Gateway 完成员工身份校验的客户端。"
      />

      <section className="metric-grid" aria-label="MCP 认证指标">
        <MetricCard
          label="已认证身份"
          value={formatNumber(authentication.identityCount)}
          detail={retentionHours ? `最近 ${retentionHours} 小时` : "网关运行时记录"}
          trend="员工 × 客户端"
          icon={Fingerprint}
        />
        <MetricCard
          label="近期活跃"
          value={formatNumber(authentication.activeIdentityCount)}
          detail={activeMinutes ? `最近 ${activeMinutes} 分钟有请求` : "近期请求"}
          trend="MCP"
          icon={Activity}
          tone="positive"
        />
        <MetricCard
          label="OAuth 客户端"
          value={formatNumber(authentication.oauthClientCount)}
          detail="按 client_id 去重"
          trend="OIDC"
          icon={MonitorSmartphone}
        />
        <MetricCard
          label="已认证请求"
          value={formatNumber(authentication.requestCount)}
          detail="当前保留窗口内"
          trend="不含失败请求"
          icon={KeyRound}
        />
      </section>

      <SectionCard
        title="MCP 已认证客户端"
        description="只读展示身份摘要；不记录或展示 Access Token、Refresh Token 与原始 Subject。"
      >
        {errors.mcpAuthentication ? (
          <div className="empty-data">
            <strong>认证数据暂不可用</strong>
            <span>MCP Access Gateway 返回：{errors.mcpAuthentication}</span>
          </div>
        ) : authentication.clients.length ? (
          <div className="table-scroll">
            <table className="data-table">
              <thead>
                <tr>
                  <th>员工身份</th>
                  <th>OAuth 客户端</th>
                  <th>Issuer</th>
                  <th>请求数</th>
                  <th>首次认证</th>
                  <th>最近访问</th>
                  <th>状态</th>
                </tr>
              </thead>
              <tbody>
                {authentication.clients.map((client) => (
                  <tr key={client.id}>
                    <td data-label="员工身份">
                      <div className="service-identity">
                        <strong>{identityName(client)}</strong>
                        <span>{client.email || client.subjectFingerprint}</span>
                      </div>
                    </td>
                    <td
                      data-label="OAuth 客户端"
                      className="cell-mono"
                      title={client.clientId}
                    >
                      {shortId(client.clientId)}
                    </td>
                    <td data-label="Issuer" className="cell-mono">
                      {client.issuer}
                    </td>
                    <td data-label="请求数" className="cell-mono">
                      {formatNumber(client.requestCount)}
                    </td>
                    <td data-label="首次认证">{formatDateTime(client.firstSeenAt)}</td>
                    <td data-label="最近访问">
                      <div className="service-identity">
                        <strong>{formatDateTime(client.lastSeenAt)}</strong>
                        <span className="cell-mono">
                          {client.lastMethod} {client.lastPath}
                        </span>
                      </div>
                    </td>
                    <td data-label="状态">
                      <span
                        className={`status-pill status-pill--${client.active ? "healthy" : "idle"} status-pill--compact`}
                      >
                        <ShieldCheck size={13} aria-hidden="true" />
                        {client.active ? "近期活跃" : "已认证"}
                      </span>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        ) : (
          <div className="empty-data">
            <strong>暂无已认证客户端</strong>
            <span>员工通过支持 AI Base MCP 的客户端成功访问后会显示在这里。</span>
          </div>
        )}
      </SectionCard>
    </div>
  );
}
