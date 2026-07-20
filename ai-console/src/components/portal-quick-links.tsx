import { Activity, ArrowRight, BrainCircuit, ExternalLink, LayoutGrid, Network, NotebookTabs } from "lucide-react";
import Link from "next/link";

const quickLinks = [
  { name: "大模型网关", product: "配置模型渠道", url: "/model-channels", icon: BrainCircuit, external: false },
  { name: "外部连接", product: "Open Connector", url: "https://open-connector.localhost.pomerium.io:8443", icon: Network, external: true },
  { name: "知识工作台", product: "SilverBullet", url: "http://knowledge.localhost:8080", icon: NotebookTabs, external: true },
  { name: "链路追踪", product: "Jaeger", url: "http://jaeger.localhost:8080", icon: Activity, external: true },
];

export function PortalQuickLinks() {
  return (
    <section className="portal-launchpad" aria-labelledby="portal-launchpad-title">
      <div className="portal-launchpad__intro">
        <span className="portal-launchpad__icon" aria-hidden="true"><LayoutGrid size={19} /></span>
        <div>
          <strong id="portal-launchpad-title">组件门户</strong>
          <span>从 AI Console 统一进入各专业工作台</span>
        </div>
        <Link href="/components">全部组件 <ArrowRight size={14} aria-hidden="true" /></Link>
      </div>
      <div className="portal-launchpad__links">
        {quickLinks.map((item) => {
          const Icon = item.icon;
          const content = <>
              <span aria-hidden="true"><Icon size={17} /></span>
              <div><strong>{item.name}</strong><small>{item.product}</small></div>
              {item.external ? <ExternalLink size={13} aria-hidden="true" /> : <ArrowRight size={13} aria-hidden="true" />}
            </>;
          return item.external
            ? <a href={item.url} target="_blank" rel="noreferrer" key={item.product}>{content}</a>
            : <Link href={item.url} key={item.product}>{content}</Link>;
        })}
      </div>
    </section>
  );
}
