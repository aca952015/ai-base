import { Activity, ArrowRight, BrainCircuit, ExternalLink, LayoutGrid, Network, NotebookTabs } from "lucide-react";
import Link from "next/link";

const quickLinks = [
  { name: "模型网关", product: "Bifrost", url: "http://localhost:8080", icon: BrainCircuit },
  { name: "外部连接", product: "Open Connector", url: "http://localhost:3100", icon: Network },
  { name: "知识工作台", product: "SilverBullet", url: "http://localhost:3001", icon: NotebookTabs },
  { name: "链路追踪", product: "Jaeger", url: "http://localhost:16686", icon: Activity },
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
          return (
            <a href={item.url} target="_blank" rel="noreferrer" key={item.product}>
              <span aria-hidden="true"><Icon size={17} /></span>
              <div><strong>{item.name}</strong><small>{item.product}</small></div>
              <ExternalLink size={13} aria-hidden="true" />
            </a>
          );
        })}
      </div>
    </section>
  );
}
