"use client";

import {
  Activity,
  Blocks,
  Bot,
  BrainCircuit,
  ChevronDown,
  ChevronRight,
  CreditCard,
  Database,
  FlaskConical,
  Gauge,
  LayoutGrid,
  Link2,
  LogOut,
  PlugZap,
  Settings,
  ShieldCheck,
  Sparkles,
  UserRound,
} from "lucide-react";
import type { LucideIcon } from "lucide-react";
import Link from "next/link";
import { usePathname } from "next/navigation";
import {
  type ReactNode,
  useEffect,
  useId,
  useRef,
  useState,
} from "react";

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
  { href: "/authentication", label: "认证", icon: ShieldCheck },
];

const settingsNavigation: NavigationItem[] = [
  { href: "/model-channels", label: "模型配置", icon: BrainCircuit },
  { href: "/mcp", label: "MCP配置", icon: Blocks },
  { href: "/integrations", label: "集成管理", icon: Link2 },
  { href: "/connectors", label: "连接器配置", icon: PlugZap },
  { href: "/account", label: "账号绑定", icon: UserRound },
  { href: "/settings", label: "系统设置", icon: Settings },
];

function isActive(pathname: string, href: string) {
  return href === "/" ? pathname === href : pathname.startsWith(href);
}

export function AppShell({
  children,
  identity,
}: {
  children: ReactNode;
  identity: { name: string; email: string; isAdmin: boolean };
}) {
  const pathname = usePathname();
  const [accountMenuOpen, setAccountMenuOpen] = useState(false);
  const accountMenuId = useId();
  const accountMenuRef = useRef<HTMLDivElement>(null);
  const accountMenuTriggerRef = useRef<HTMLButtonElement>(null);
  const visibleNavigation = identity.isAdmin ? navigation : [];
  const visibleSettingsNavigation = identity.isAdmin
    ? settingsNavigation
    : settingsNavigation.filter((item) => item.href === "/account");
  const initials = identity.name.trim().slice(0, 2).toUpperCase() || "AI";
  const roleLabel = identity.isAdmin ? "管理员" : "员工";

  useEffect(() => {
    if (!accountMenuOpen) return;

    function handlePointerDown(event: PointerEvent) {
      if (!accountMenuRef.current?.contains(event.target as Node)) {
        setAccountMenuOpen(false);
      }
    }

    function handleKeyDown(event: KeyboardEvent) {
      if (event.key !== "Escape") return;
      setAccountMenuOpen(false);
      accountMenuTriggerRef.current?.focus();
    }

    document.addEventListener("pointerdown", handlePointerDown);
    document.addEventListener("keydown", handleKeyDown);
    return () => {
      document.removeEventListener("pointerdown", handlePointerDown);
      document.removeEventListener("keydown", handleKeyDown);
    };
  }, [accountMenuOpen]);

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

        <div className="sidebar-navigation-scroll">
          {visibleNavigation.length > 0 ? (
            <nav className="primary-nav">
              <div className="nav-section-label">工作台</div>
              {visibleNavigation.map((item) => {
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
          ) : null}

          <nav className="primary-nav nav-group" aria-label="设置">
            <div className="nav-section-label">设置</div>
            {visibleSettingsNavigation.map((item) => {
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
        </div>

        <div className="operator-menu-wrap" ref={accountMenuRef}>
          {accountMenuOpen ? (
            <div className="operator-menu" id={accountMenuId} role="menu" aria-label="当前账号菜单">
              <button className="operator-menu__item" disabled role="menuitem" type="button">
                <UserRound size={17} aria-hidden="true" />
                <span>账户信息</span>
                <small>即将开放</small>
              </button>
              <button className="operator-menu__item" disabled role="menuitem" type="button">
                <ShieldCheck size={17} aria-hidden="true" />
                <span>安全</span>
                <small>即将开放</small>
              </button>
              <button className="operator-menu__item" disabled role="menuitem" type="button">
                <CreditCard size={17} aria-hidden="true" />
                <span>费用</span>
                <small>即将开放</small>
              </button>
              <div className="operator-menu__separator" role="separator" />
              {identity.isAdmin ? (
                <Link
                  className="operator-menu__item"
                  href="/settings"
                  onClick={() => setAccountMenuOpen(false)}
                  role="menuitem"
                >
                  <Settings size={17} aria-hidden="true" />
                  <span>设置</span>
                  <ChevronRight className="operator-menu__trailing" size={15} aria-hidden="true" />
                </Link>
              ) : (
                <button className="operator-menu__item" disabled role="menuitem" type="button">
                  <Settings size={17} aria-hidden="true" />
                  <span>设置</span>
                  <small>即将开放</small>
                </button>
              )}
              <div className="operator-menu__separator" role="separator" />
              <a className="operator-menu__item is-danger" href="/.pomerium/sign_out" role="menuitem">
                <LogOut size={17} aria-hidden="true" />
                <span>退出登录</span>
              </a>
            </div>
          ) : null}

          <button
            aria-controls={accountMenuId}
            aria-expanded={accountMenuOpen}
            aria-haspopup="menu"
            className={`operator-card${accountMenuOpen ? " is-open" : ""}`}
            onClick={() => setAccountMenuOpen((open) => !open)}
            ref={accountMenuTriggerRef}
            type="button"
          >
            <div className="operator-avatar" aria-hidden="true">
              {initials}
            </div>
            <div className="operator-copy">
              <div className="operator-name-row">
                <strong>{identity.name}</strong>
                <span className={`operator-badge ${identity.isAdmin ? "is-admin" : "is-employee"}`}>
                  {roleLabel}
                </span>
              </div>
              <span className="operator-email" title={identity.email}>
                {identity.email}
              </span>
            </div>
            <ChevronDown className="operator-chevron" size={16} aria-hidden="true" />
          </button>
        </div>
      </aside>

      <div className="shell-column">
        <main className="main-content" id="main-content">
          {children}
        </main>
      </div>
    </div>
  );
}
