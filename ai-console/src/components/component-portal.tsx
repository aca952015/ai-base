"use client";

import {
  Activity,
  ArrowRight,
  Bot,
  BrainCircuit,
  CircleGauge,
  Database,
  ExternalLink,
  Network,
  NotebookTabs,
  RefreshCw,
  Router,
  ShieldCheck,
} from "lucide-react";
import type { LucideIcon } from "lucide-react";
import Link from "next/link";
import { useState } from "react";

import { portalCategories, portalEntries } from "@/lib/control-plane/portal";
import type { ServiceId, ServiceSnapshot } from "@/lib/control-plane/types";

import { StatusPill } from "./status-pill";

const portalIcons: Record<ServiceId, LucideIcon> = {
  "global-gateway": Router,
  "mcp-access-gateway": ShieldCheck,
  "agent-runtime": Bot,
  "llm-gateway": BrainCircuit,
  "open-connector": Network,
  silverbullet: NotebookTabs,
  postgres: Database,
  promptfoo: ShieldCheck,
  jaeger: Activity,
};

export function ComponentPortal({ initialServices }: { initialServices: ServiceSnapshot[] }) {
  const [services, setServices] = useState(initialServices);
  const [isChecking, setIsChecking] = useState(false);
  const [message, setMessage] = useState("当前显示实时探测结果");

  const healthyCount = services.filter((service) => service.status === "healthy").length;
  const attentionCount = services.filter((service) =>
    ["degraded", "offline", "unconfigured"].includes(service.status),
  ).length;
  const idleCount = services.filter((service) => service.status === "idle").length;

  async function refreshServices() {
    setIsChecking(true);
    setMessage("正在刷新全部组件…");

    try {
      const response = await fetch("/api/services", { cache: "no-store" });
      if (!response.ok) throw new Error(`刷新失败（${response.status}）`);
      const payload = (await response.json()) as ServiceSnapshot[];
      setServices(payload);
      setMessage(`已于 ${new Date().toLocaleTimeString("zh-CN", { hour: "2-digit", minute: "2-digit" })} 更新`);
    } catch (error) {
      setMessage(error instanceof Error ? error.message : "刷新组件状态失败");
    } finally {
      setIsChecking(false);
    }
  }

  return (
    <div className="portal-stack">
      <section className="portal-summary" aria-label="组件门户摘要">
        <article>
          <span className="portal-summary__icon"><CircleGauge size={18} /></span>
          <div><strong>{services.length}</strong><span>已纳管组件</span></div>
        </article>
        <article>
          <span className="portal-summary__icon portal-summary__icon--healthy"><ShieldCheck size={18} /></span>
          <div><strong>{healthyCount}</strong><span>运行正常</span></div>
        </article>
        <article>
          <span className="portal-summary__icon"><RefreshCw size={18} /></span>
          <div><strong>{idleCount}</strong><span>按需运行</span></div>
        </article>
        <article className={attentionCount > 0 ? "has-attention" : ""}>
          <span className="portal-summary__icon"><Network size={18} /></span>
          <div><strong>{attentionCount}</strong><span>需要处理</span></div>
        </article>
      </section>

      <div className="portal-toolbar">
        <div>
          <strong>统一组件目录</strong>
          <span aria-live="polite">{message}</span>
        </div>
        <button className="button button--secondary" type="button" onClick={refreshServices} disabled={isChecking}>
          <RefreshCw className={isChecking ? "is-spinning" : ""} size={15} aria-hidden="true" />
          {isChecking ? "刷新中" : "刷新状态"}
        </button>
      </div>

      {portalCategories.map((category) => (
        <section className="portal-group" key={category.id} aria-labelledby={`portal-${category.id}`}>
          <header className="portal-group__header">
            <div>
              <h2 id={`portal-${category.id}`}>{category.title}</h2>
              <p>{category.description}</p>
            </div>
            <span>{portalEntries.filter((entry) => entry.category === category.id).length} 个组件</span>
          </header>

          <div className="portal-grid">
            {portalEntries.filter((entry) => entry.category === category.id).map((entry) => {
              const service = services.find((item) => item.id === entry.id);
              if (!service) return null;
              const Icon = portalIcons[entry.id];

              return (
                <article className="portal-card" key={entry.id}>
                  <div className="portal-card__top">
                    <span className={`portal-card__icon portal-card__icon--${service.group}`} aria-hidden="true">
                      <Icon size={21} />
                    </span>
                    <StatusPill status={service.status} compact />
                  </div>
                  <div className="portal-card__identity">
                    <span>{service.product} · v{service.version}</span>
                    <h3>{service.name}</h3>
                    <p>{service.description}</p>
                  </div>
                  <ul className="portal-card__capabilities" aria-label={`${service.name}能力`}>
                    {service.capabilities.map((capability) => <li key={capability}>{capability}</li>)}
                  </ul>
                  <div className="portal-card__runtime">
                    <span>{service.detail}</span>
                    <code>{service.endpoint ?? "由 Docker profile 按需提供"}</code>
                  </div>
                  <div className="portal-card__actions">
                    {entry.workspaceUrl ? (
                      <a className="button button--primary" href={entry.workspaceUrl} target="_blank" rel="noreferrer">
                        {entry.workspaceLabel} <ExternalLink size={14} aria-hidden="true" />
                      </a>
                    ) : (
                      <Link className="button button--primary" href={entry.managePath}>
                        {entry.manageLabel} <ArrowRight size={14} aria-hidden="true" />
                      </Link>
                    )}
                    {entry.workspaceUrl ? (
                      <Link className="button button--secondary" href={entry.managePath}>{entry.manageLabel}</Link>
                    ) : null}
                    {entry.managePath.startsWith("/settings") ? null : (
                      <Link className="portal-card__settings" href={`/settings#service-${entry.id}`}>端点配置</Link>
                    )}
                  </div>
                </article>
              );
            })}
          </div>
        </section>
      ))}
    </div>
  );
}
