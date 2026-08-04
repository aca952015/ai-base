import { ChevronRight, KeyRound, LockKeyhole, MessageSquareLock, NotebookTabs, Router, ServerCog, ShieldCheck, TriangleAlert } from "lucide-react";
import Link from "next/link";

import { PageHeader } from "@/components/page-header";
import { SectionCard } from "@/components/section-card";
import { SettingsForm } from "@/components/settings-form";
import { getComponentData } from "@/lib/server/component-data";
import { getWeComAuthenticationSnapshot, readConfig } from "@/lib/server/config";
import { readGatewayMcpServers } from "@/lib/server/gateway-config";

export const dynamic = "force-dynamic";

function SecretState({ ready, readyLabel = "已验证" }: { ready: boolean; readyLabel?: string }) {
  return ready
    ? <span className="secret-state is-ready"><ShieldCheck size={14} /> {readyLabel}</span>
    : <span className="secret-state is-warning"><TriangleAlert size={14} /> 未配置</span>;
}

export default async function SettingsPage() {
  const config = await readConfig();
  const [data, mcpSnapshot] = await Promise.all([
    getComponentData(config),
    readGatewayMcpServers(),
  ]);
  const wecomAuth = getWeComAuthenticationSnapshot(config);
  const connectorApiReady = !data.errors.openConnector;
  const runtimeTokenConfigured = Boolean(process.env.OPEN_CONNECTOR_RUNTIME_TOKEN);
  const oidcConfigured = process.env.OIDC_ENABLED === "true";
  const globalGatewayReady = data.services.some((service) => service.id === "global-gateway" && service.status === "healthy");
  const envoyReady = data.services.some((service) => service.id === "llm-gateway" && service.status === "healthy");

  return (
    <div className="page-stack">
      <PageHeader title="系统设置" description="管理运行环境和服务端点；组件状态来自实际配置与 API，不回显任何密钥。" />
      <SectionCard title="组件配置" description="进入组件二级设置，配置会由 AI Console 验证并应用到实际服务。">
        <div className="settings-subpage-list">
          <Link className="settings-subpage-row" href="/settings/lightrag">
            <span className="settings-subpage-row__icon"><NotebookTabs size={19} /></span>
            <span className="settings-subpage-row__copy"><strong>LightRAG</strong><small>模型、Embedding、切片与并发</small></span>
            <span className="settings-subpage-row__status">{data.knowledge.pipelineBusy ? "索引处理中" : `${data.knowledge.documentCount} 篇文档`}</span>
            <ChevronRight size={18} />
          </Link>
          <Link className="settings-subpage-row" href="/settings/wecom-auth">
            <span className="settings-subpage-row__icon is-green"><MessageSquareLock size={19} /></span>
            <span className="settings-subpage-row__copy"><strong>企业微信认证</strong><small>公开入口、回调方式与员工邮箱域</small></span>
            <span className="settings-subpage-row__status">{wecomAuth.callbackMode === "relay" ? "公网中继" : "直接回调"}</span>
            <ChevronRight size={18} />
          </Link>
        </div>
      </SectionCard>
      <div className="settings-notice" role="note"><ServerCog size={19} aria-hidden="true" /><div><strong>配置应用边界</strong><p>基础端点和非敏感运行参数保存在 Console；组件二级设置会明确标注生效时机。内部 Token、OIDC Client Secret 与签名密钥仍由部署密钥管理。</p></div></div>
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
            <li><ShieldCheck size={16} /><span><strong>知识数据最小化</strong>Console 只读取 LightRAG 文档状态，不读取或返回知识正文</span></li>
            <li><ShieldCheck size={16} /><span><strong>能力入口分层</strong>全局网关统一代理功能流量；Envoy AI 仍只承担模型与 MCP</span></li>
            <li><ShieldCheck size={16} /><span><strong>请求体隔离</strong>Console 不读取模型请求/响应或 Jaeger Span 日志</span></li>
            {!oidcConfigured ? <li className="is-warning"><TriangleAlert size={16} /><span><strong>OIDC 未接入</strong>当前仅适用于 loopback 本机验证</span></li> : null}
          </ul>
        </SectionCard>
      </div>
    </div>
  );
}
