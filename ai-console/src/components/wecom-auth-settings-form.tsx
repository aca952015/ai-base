"use client";

import {
  Check,
  CheckCircle2,
  Copy,
  Plus,
  RefreshCw,
  Save,
  ShieldCheck,
  Trash2,
  X,
} from "lucide-react";
import { useCallback, useEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";

import type {
  WeComAuthenticationOrganizationSnapshot,
  WeComAuthenticationSettings,
  WeComAuthenticationSnapshot,
} from "@/lib/control-plane/types";

type SaveState = "idle" | "saving" | "saved" | "deleting" | "error";

const emptySettings: WeComAuthenticationSettings = {
  organizationName: "",
  corpId: "",
  relayCallbackUrl: "https://tn1.cofly-ai.cn/callbacks/wecom",
  active: true,
};

function settingsFromSnapshot(snapshot: WeComAuthenticationOrganizationSnapshot): WeComAuthenticationSettings {
  return {
    id: snapshot.id,
    organizationName: snapshot.organizationName,
    corpId: snapshot.corpId,
    relayCallbackUrl: snapshot.relayCallbackUrl,
    active: snapshot.active,
  };
}

function formatSavedAt(value?: string) {
  if (!value) return "尚未保存";
  const timestamp = Date.parse(value);
  return Number.isNaN(timestamp)
    ? "未知"
    : new Intl.DateTimeFormat("zh-CN", {
      dateStyle: "medium",
      timeStyle: "short",
      timeZone: "Asia/Shanghai",
    }).format(timestamp);
}

export function WeComAuthSettingsForm({
  initialSnapshot,
  initialError,
}: {
  initialSnapshot: WeComAuthenticationSnapshot;
  initialError?: string;
}) {
  const [organizations, setOrganizations] = useState(initialSnapshot.organizations);
  const [settings, setSettings] = useState<WeComAuthenticationSettings>();
  const [state, setState] = useState<SaveState>(initialError ? "error" : "idle");
  const [message, setMessage] = useState(initialError || "");
  const drawerRef = useRef<HTMLElement>(null);
  const isEditorOpen = Boolean(settings);
  const currentSnapshot = settings?.id
    ? organizations.find((organization) => organization.id === settings.id)
    : undefined;

  const closeEditor = useCallback(() => {
    if (state === "saving" || state === "deleting") return;
    setSettings(undefined);
  }, [state]);

  useEffect(() => {
    if (!isEditorOpen) return;
    const previouslyFocused = document.activeElement instanceof HTMLElement ? document.activeElement : undefined;
    const previousOverflow = document.body.style.overflow;
    document.body.style.overflow = "hidden";
    const frame = requestAnimationFrame(() => {
      drawerRef.current?.querySelector<HTMLElement>("[data-drawer-autofocus]")?.focus();
    });
    function handleKeyDown(event: KeyboardEvent) {
      if (event.key === "Escape") closeEditor();
    }
    document.addEventListener("keydown", handleKeyDown);
    return () => {
      cancelAnimationFrame(frame);
      document.removeEventListener("keydown", handleKeyDown);
      document.body.style.overflow = previousOverflow;
      previouslyFocused?.focus();
    };
  }, [closeEditor, isEditorOpen]);

  function openOrganization(organization?: WeComAuthenticationOrganizationSnapshot) {
    setSettings(organization ? settingsFromSnapshot(organization) : { ...emptySettings });
    setState("idle");
    setMessage("");
  }

  function update(patch: Partial<WeComAuthenticationSettings>) {
    setSettings((current) => current ? { ...current, ...patch } : current);
    setState("idle");
    setMessage("配置尚未保存");
  }

  async function saveSettings() {
    if (!settings) return;
    setState("saving");
    setMessage("正在验证并保存…");
    try {
      const response = await fetch("/api/integrations/wecom-authentication", {
        method: settings.id ? "PUT" : "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(settings),
      });
      const payload = await response.json() as WeComAuthenticationOrganizationSnapshot & {
        error?: string;
        details?: string[];
      };
      if (!response.ok) throw new Error(payload.details?.[0] ?? payload.error ?? "保存失败");
      setOrganizations((current) => [
        ...current.filter((organization) => organization.id !== payload.id),
        payload,
      ].sort((left, right) => left.organizationName.localeCompare(right.organizationName, "zh-CN")));
      setSettings(undefined);
      setState("saved");
      setMessage(settings.id ? "组织配置已更新" : "认证组织已添加");
    } catch (error) {
      setState("error");
      setMessage(error instanceof Error ? error.message : "保存失败");
    }
  }

  async function deleteOrganization() {
    if (!settings?.id || !window.confirm(`确认删除认证组织 ${settings.organizationName}？`)) return;
    setState("deleting");
    setMessage("正在删除组织配置…");
    try {
      const response = await fetch(`/api/integrations/wecom-authentication?id=${encodeURIComponent(settings.id)}`, {
        method: "DELETE",
      });
      const payload = await response.json().catch(() => ({})) as { error?: string };
      if (!response.ok) throw new Error(payload.error || "删除失败");
      setOrganizations((current) => current.filter((organization) => organization.id !== settings.id));
      setSettings(undefined);
      setMessage("组织配置已删除");
      setState("saved");
    } catch (error) {
      setState("error");
      setMessage(error instanceof Error ? error.message : "删除失败");
    }
  }

  return (
    <>
      {message && !isEditorOpen ? (
        <p className={`gateway-channel-message integration-page-message${state === "error" ? " is-error" : ""}`} aria-live="polite">
          {state === "saved" ? <CheckCircle2 size={15} /> : null}
          {message}
        </p>
      ) : null}

      <section className="portal-group gateway-resource-section integration-platform-group" aria-labelledby="wecom-auth-organizations-title">
        <header className="portal-group__header">
          <div className="integration-platform-heading">
            <span className="gateway-channel-tile__icon integration-icon integration-icon--wecom"><ShieldCheck size={18} /></span>
            <div>
              <h2 id="wecom-auth-organizations-title">认证组织</h2>
              <p>一个平台用户可分别绑定多个组织中的企业微信身份。</p>
            </div>
          </div>
          <button className="button button--secondary" type="button" onClick={() => openOrganization()}>
            <Plus size={15} />增加认证组织
          </button>
        </header>

        <div className="gateway-channel-grid integration-application-grid wecom-organization-grid">
          {organizations.map((organization) => (
            <article
              className="gateway-channel-tile integration-application-card wecom-organization-card is-clickable"
              key={organization.id}
              tabIndex={0}
              onClick={() => openOrganization(organization)}
              onKeyDown={(event) => {
                if (event.key !== "Enter" && event.key !== " ") return;
                event.preventDefault();
                openOrganization(organization);
              }}
            >
              <div className="gateway-channel-tile__top">
                <span className="gateway-channel-tile__icon integration-icon integration-icon--wecom"><ShieldCheck size={18} /></span>
                <div>
                  <strong title={organization.organizationName}>{organization.organizationName}</strong>
                  <small title={organization.corpId}>{organization.corpId}</small>
                </div>
                {organization.configured ? (
                  <span className="integration-active-badge"><CheckCircle2 size={12} />已启用</span>
                ) : (
                  <span className="gateway-channel-state">{organization.active ? "未完成" : "已停用"}</span>
                )}
              </div>
              <p className="integration-application-note">
                {organization.configured
                  ? "企业微信系统认证已配置"
                  : organization.active ? "完成 CorpID 与 HTTPS 中继映射后可用" : "该认证组织当前停用"}
              </p>
              <div className="integration-application-status">
                <span>中继凭据由部署环境托管</span>
                <span>更新于 {formatSavedAt(organization.updatedAt)}</span>
              </div>
            </article>
          ))}
          <button className="gateway-channel-add-card integration-add-card" type="button" onClick={() => openOrganization()}>
            <span><Plus size={19} /></span>
            <strong>增加认证组织</strong>
            <small>配置组织映射和认证入口</small>
          </button>
        </div>
      </section>

      {settings ? createPortal(
        <div className="gateway-channel-drawer-backdrop" onMouseDown={(event) => { if (event.target === event.currentTarget) closeEditor(); }}>
          <aside className="gateway-channel-drawer connector-drawer integration-drawer" ref={drawerRef} role="dialog" aria-modal="true" aria-labelledby="wecom-auth-editor-title">
            <div className="gateway-channel-editor__header">
              <div>
                <h3 id="wecom-auth-editor-title">{settings.id ? "编辑认证组织" : "增加认证组织"}</h3>
                <p>维护组织映射和企业微信应用认证入口。</p>
              </div>
              <button type="button" data-drawer-autofocus onClick={closeEditor} disabled={state === "saving" || state === "deleting"} aria-label="关闭认证组织配置"><X size={17} /></button>
            </div>

            <form
              className="gateway-channel-drawer__body integration-editor-body"
              id="wecom-auth-editor-form"
              onSubmit={(event) => { event.preventDefault(); void saveSettings(); }}
            >
              <section className="resource-detail-section integration-credential-form">
                <div className="resource-detail-section__header">
                  <strong>组织配置</strong>
                  <span className="secret-state is-ready">
                    <ShieldCheck size={14} />中继凭据由环境托管
                  </span>
                </div>
                <div className="gateway-channel-fields connector-fields integration-form-fields">
                  <label className="field-label gateway-channel-field--wide">
                    <span>组织名称</span>
                    <input required value={settings.organizationName} placeholder="例如：示例组织" onChange={(event) => update({ organizationName: event.target.value })} />
                  </label>
                  <label className="field-label gateway-channel-field--wide">
                    <span>企业 ID（CorpID）</span>
                    <input required value={settings.corpId} placeholder="wwxxxxxxxxxxxxxxxx" onChange={(event) => update({ corpId: event.target.value })} autoComplete="off" />
                  </label>
                  <label className="field-label gateway-channel-field--wide">
                    <span>公网认证中继回调地址</span>
                    <input type="url" required value={settings.relayCallbackUrl} onChange={(event) => update({ relayCallbackUrl: event.target.value })} />
                    <small>必须使用 HTTPS。CorpID 与 App Secret 由该中继的部署环境配置并负责身份交换。</small>
                  </label>
                  <label className="field-label field-label--toggle gateway-channel-field--wide">
                    <span>启用认证</span>
                    <input type="checkbox" checked={settings.active} onChange={(event) => update({ active: event.target.checked })} />
                  </label>
                  {currentSnapshot ? (
                    <div className="field-label gateway-channel-field--wide">
                      <span>企业微信应用首页</span>
                      <div className="connector-copy-row">
                        <input readOnly value={currentSnapshot.applicationHomepageUrl} aria-label="企业微信应用首页" />
                        <button type="button" onClick={() => void navigator.clipboard.writeText(currentSnapshot.applicationHomepageUrl)}><Copy size={15} />复制</button>
                      </div>
                      <small>复制到该组织企业微信应用的应用首页；这是中继固定入口，不包含内部组织 ID。</small>
                    </div>
                  ) : null}
                </div>
              </section>
            </form>

            <div className="gateway-channel-editor__footer wecom-auth-editor-footer">
              <div className="wecom-auth-editor-status">
                <p aria-live="polite" className={state === "error" ? "form-message form-message--error" : "form-message"}>
                  {state === "saved" ? <Check size={15} aria-hidden="true" /> : null}{message}
                </p>
                <small>最近保存：{formatSavedAt(currentSnapshot?.updatedAt)}</small>
              </div>
              {settings.id ? (
                <button className="gateway-remove-button integration-delete-button" type="button" onClick={() => void deleteOrganization()} disabled={state === "saving" || state === "deleting"}>
                  <Trash2 size={15} />{state === "deleting" ? "删除中" : "删除"}
                </button>
              ) : null}
              <button className="button button--secondary" type="button" onClick={closeEditor} disabled={state === "saving" || state === "deleting"}>取消</button>
              <button className="button button--primary" type="submit" form="wecom-auth-editor-form" disabled={state === "saving" || state === "deleting"}>
                {state === "saving" ? <RefreshCw className="is-spinning" size={14} /> : <Save size={14} />}
                {state === "saving" ? "保存中" : "保存"}
              </button>
            </div>
          </aside>
        </div>,
        document.body,
      ) : null}
    </>
  );
}
