"use client";

import {
  Activity,
  Blocks,
  Bot,
  BrainCircuit,
  ChevronDown,
  Database,
  FlaskConical,
  Gauge,
  LayoutGrid,
  Settings,
  Sparkles,
} from "lucide-react";
import type { LucideIcon } from "lucide-react";
import Link from "next/link";
import { usePathname } from "next/navigation";
import type { ReactNode } from "react";

import type { ConsoleConfig } from "@/lib/control-plane/types";

type NavigationItem = {
  href: string;
  label: string;
  icon: LucideIcon;
};

const navigation: NavigationItem[] = [
  { href: "/", label: "总览", icon: Gauge },
  { href: "/components", label: "组件门户", icon: LayoutGrid },
  { href: "/agents", label: "Agent", icon: Bot },
  { href: "/capabilities", label: "能力", icon: Blocks },
  { href: "/data", label: "数据", icon: Database },
  { href: "/evaluations", label: "评测", icon: FlaskConical },
  { href: "/observability", label: "可观测", icon: Activity },
];

const settingsNavigation: NavigationItem[] = [
  { href: "/model-channels", label: "模型配置", icon: BrainCircuit },
  { href: "/mcp", label: "MCP配置", icon: Blocks },
  { href: "/settings", label: "系统设置", icon: Settings },
];

function isActive(pathname: string, href: string) {
  return href === "/" ? pathname === href : pathname.startsWith(href);
}

const environmentLabels: Record<ConsoleConfig["environment"], string> = {
  development: "开发环境",
  staging: "预发环境",
  production: "生产环境",
};

export function AppShell({ children, environment }: { children: ReactNode; environment: ConsoleConfig["environment"] }) {
  const pathname = usePathname();

  return (
    <div className="app-shell">
      <a className="skip-link" href="#main-content">
        跳到主要内容
      </a>

      <aside className="sidebar" aria-label="主导航">
        <div className="brand-block">
          <div className="brand-mark" aria-hidden="true">
            <Sparkles size={18} strokeWidth={2.2} />
          </div>
          <div>
            <div className="brand-name">AI Base</div>
            <div className="brand-subtitle">Stack portal</div>
          </div>
        </div>

        <nav className="primary-nav">
          <div className="nav-section-label">工作台</div>
          {navigation.map((item) => {
            const Icon = item.icon;
            const active = isActive(pathname, item.href);

            return (
              <Link
                className={`nav-link${active ? " is-active" : ""}`}
                href={item.href}
                key={item.href}
                aria-current={active ? "page" : undefined}
              >
                <Icon size={18} aria-hidden="true" />
                <span>{item.label}</span>
              </Link>
            );
          })}
        </nav>

        <nav className="primary-nav nav-group" aria-label="设置">
          <div className="nav-section-label">设置</div>
          {settingsNavigation.map((item) => {
            const Icon = item.icon;
            const active = isActive(pathname, item.href);

            return (
              <Link
                className={`nav-link${active ? " is-active" : ""}`}
                href={item.href}
                key={item.href}
                aria-current={active ? "page" : undefined}
              >
                <Icon size={18} aria-hidden="true" />
                <span>{item.label}</span>
              </Link>
            );
          })}
        </nav>

        <div className="sidebar-spacer" />

        <div className="operator-card">
          <div className="operator-avatar" aria-hidden="true">
            AC
          </div>
          <div className="operator-copy">
            <strong>本地管理员</strong>
            <span>OIDC 尚未接入</span>
          </div>
          <ChevronDown size={16} aria-hidden="true" />
        </div>
      </aside>

      <div className="shell-column">
        <header className="topbar">
          <div className="topbar-product">
            <span className="mobile-brand-mark" aria-hidden="true">
              <Sparkles size={16} />
            </span>
            <span>Agent 基础设施门户</span>
          </div>
          <div className="topbar-actions">
            <Link className="command-link" href="/agents">
              <span>搜索 Agent、组件或 Trace</span>
              <kbd>⌘ K</kbd>
            </Link>
            <div className="environment-badge">
              <span className="status-dot status-dot--healthy" aria-hidden="true" />
              {environmentLabels[environment]}
            </div>
          </div>
        </header>

        <main className="main-content" id="main-content">
          {children}
        </main>
      </div>
    </div>
  );
}
