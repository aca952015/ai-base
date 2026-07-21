import { KeyRound, LockKeyhole, Router, ServerCog, ShieldCheck, TriangleAlert } from "lucide-react";

import { PageHeader } from "@/components/page-header";
import { SectionCard } from "@/components/section-card";
import { SettingsForm } from "@/components/settings-form";
import { getComponentData } from "@/lib/server/component-data";
import { readConfig } from "@/lib/server/config";
import { readGatewayMcpServers } from "@/lib/server/gateway-config";

export const dynamic = "force-dynamic";

function SecretState({ ready, readyLabel = "已验证" }: { ready: boolean; readyLabel?: string }) {
  return ready
    ? <span className="secret-state is-ready"><ShieldCheck size={14} /> {readyLabel}</span>
    : <span className="secret-state is-warning"><TriangleAlert size={14} /> 未配置</span>;
}

export default async function SettingsPage() {
  const [data, mcpSnapshot] = await Promise.all([
    getComponentData(await readConfig()),
    readGatewayMcpServers(),
  ]);
  const connectorApiReady = !data.errors.openConnector;
  const runtimeTokenConfigured = Boolean(process.env.OPEN_CONNECTOR_RUNTIME_TOKEN);
  const oidcConfigured = process.env.OIDC_ENABLED === "true";
  const globalGatewayReady = data.services.some((service) => service.id === "global-gateway" && service.status === "healthy");
  const envoyReady = data.services.some((service) => service.id === "llm-gateway" && service.status === "healthy");

  return (
    <div className="page-stack">
      <PageHeader title="系统设置" description="管理运行环境和服务端点；组件状态来自实际配置与 API，不回显任何密钥。" />
      <div className="settings-notice" role="note"><ServerCog size={19} aria-hidden="true" /><div><strong>配置与生产发布分离</strong><p>此页面验证并保存 Console 本地配置。正式环境建议由 SOPS + age 管理敏感变量，再通过受控发布流程注入。</p></div></div>
      <SectionCard title="基础设置与服务端点" description="停用能力后，健康检查会标记为“尚未配置”，而不是误报服务故障。"><SettingsForm /></SectionCard>
      <div className="dashboard-grid dashboard-grid--equal">
        <SectionCard title="真实配置状态" description="只展示 API 可用性和配置计数，不读取或回显原始值。">
          <ul className="secret-list">
            <li><span><Router size={16} /><strong>统一功能入口</strong></span><SecretState ready={globalGatewayReady} readyLabel="模型 / MCP / RAG / Runtime / Connector / OTLP" /></li>
            <li><span><KeyRound size={16} /><strong>Envoy AI API</strong></span><SecretState ready={envoyReady} readyLabel={`${data.modelGateway.channelCount} 个渠道 / ${data.modelGateway.modelCount} 个模型 / ${mcpSnapshot.servers.filter((server) => server.enabled).length} 个 MCP`} /></li>
            <li><span><LockKeyhole size={16} /><strong>OpenConnector Admin API</strong></span><SecretState ready={connectorApiReady} /></li>
            <li><span><KeyRound size={16} /><strong>OpenConnector Runtime Token</strong></span><SecretState ready={runtimeTokenConfigured} readyLabel="服务端已注入" /></li>
            <li><span><LockKeyhole size={16} /><strong>企业 OIDC</strong></span><SecretState ready={oidcConfigured} /></li>
          </ul>
        </SectionCard>
        <SectionCard title="安全边界" description="本页能由当前部署事实验证的最低控制项。">
          <ul className="check-list">
            <li><ShieldCheck size={16} /><span><strong>Token 仅在服务端</strong>聚合 API 不向浏览器返回原始凭证</span></li>
            <li><ShieldCheck size={16} /><span><strong>知识只读</strong>Console 以只读挂载读取 SilverBullet 文件元数据</span></li>
            <li><ShieldCheck size={16} /><span><strong>能力入口分层</strong>全局网关统一代理功能流量；Envoy AI 仍只承担模型与 MCP</span></li>
            <li><ShieldCheck size={16} /><span><strong>请求体隔离</strong>Console 不读取模型请求/响应或 Jaeger Span 日志</span></li>
            {!oidcConfigured ? <li className="is-warning"><TriangleAlert size={16} /><span><strong>OIDC 未接入</strong>当前仅适用于 loopback 本机验证</span></li> : null}
          </ul>
        </SectionCard>
      </div>
    </div>
  );
}
