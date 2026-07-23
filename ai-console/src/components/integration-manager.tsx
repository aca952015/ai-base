"use client";

import {
  Building2,
  CheckCircle2,
  LockKeyhole,
  MessageSquareShare,
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
  EnterpriseIntegrationGroup,
  EnterpriseIntegrationPlatform,
  EnterpriseIntegrationsSnapshot,
  IntegrationApplication,
} from "@/lib/control-plane/integrations";
import { formatDateTime } from "@/lib/format";

type EditorState = {
  mode: "create" | "edit";
  platform: EnterpriseIntegrationPlatform;
  application?: IntegrationApplication;
  name: string;
  appId: string;
  note: string;
  appSecret: string;
};

const platformIcons = {
  feishu: MessageSquareShare,
  wecom: Building2,
  dingtalk: ShieldCheck,
} satisfies Record<EnterpriseIntegrationPlatform, typeof MessageSquareShare>;

function errorMessage(payload: unknown, fallback: string) {
  if (payload && typeof payload === "object" && "error" in payload && typeof payload.error === "string") {
    return payload.error;
  }
  return fallback;
}

async function fetchJson<T>(url: string, init?: RequestInit): Promise<T> {
  const response = await fetch(url, { ...init, cache: "no-store" });
  const payload = await response.json().catch(() => undefined) as unknown;
  if (!response.ok) throw new Error(errorMessage(payload, `请求失败（${response.status}）`));
  return payload as T;
}

export function IntegrationManager({
  initialSnapshot,
  initialError,
}: {
  initialSnapshot: EnterpriseIntegrationsSnapshot;
  initialError?: string;
}) {
  const [snapshot, setSnapshot] = useState(initialSnapshot);
  const [editor, setEditor] = useState<EditorState>();
  const [state, setState] = useState<"idle" | "saving" | "saved" | "deleting" | "error">(initialError ? "error" : "idle");
  const [message, setMessage] = useState(initialError || "");
  const drawerRef = useRef<HTMLElement>(null);
  const isEditorOpen = Boolean(editor);

  const closeEditor = useCallback(() => {
    if (state === "saving" || state === "deleting") return;
    setEditor(undefined);
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

  function addApplication(platform: EnterpriseIntegrationPlatform) {
    setEditor({
      mode: "create",
      platform,
      name: "",
      appId: "",
      note: "",
      appSecret: "",
    });
    setState("idle");
    setMessage("");
  }

  function editApplication(application: IntegrationApplication) {
    setEditor({
      mode: "edit",
      platform: application.platform,
      application,
      name: application.name,
      appId: application.appId,
      note: application.note,
      appSecret: "",
    });
    setState("idle");
    setMessage("");
  }

  function platformGroup(platform: EnterpriseIntegrationPlatform) {
    return snapshot.groups.find((group) => group.platform === platform);
  }

  async function reload() {
    const next = await fetchJson<EnterpriseIntegrationsSnapshot>("/api/integrations");
    setSnapshot(next);
    return next;
  }

  async function saveEditor() {
    if (!editor) return;
    if (!editor.name.trim()) {
      setState("error");
      setMessage("应用名称不能为空");
      return;
    }
    if (!editor.appId.trim()) {
      setState("error");
      setMessage("App ID 不能为空");
      return;
    }
    if (editor.mode === "create" && !editor.appSecret.trim()) {
      setState("error");
      setMessage("App Secret 不能为空");
      return;
    }

    setState("saving");
    setMessage("正在加密并保存应用配置…");
    try {
      const url = editor.mode === "create"
        ? "/api/integrations"
        : `/api/integrations/${encodeURIComponent(editor.application!.id)}`;
      await fetchJson(url, {
        method: editor.mode === "create" ? "POST" : "PUT",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          platform: editor.platform,
          name: editor.name,
          appId: editor.appId,
          note: editor.note,
          appSecret: editor.appSecret || undefined,
        }),
      });
      await reload();
      setEditor(undefined);
      setState("saved");
      setMessage(editor.mode === "create" ? "应用配置已添加" : "应用配置已更新");
    } catch (error) {
      setState("error");
      setMessage(error instanceof Error ? error.message : "应用配置保存失败");
    }
  }

  async function deleteEditor() {
    if (!editor?.application || !window.confirm(`确认删除应用 ${editor.application.name}？`)) return;
    setState("deleting");
    setMessage("正在删除应用配置…");
    try {
      await fetchJson(`/api/integrations/${encodeURIComponent(editor.application.id)}`, {
        method: "DELETE",
      });
      await reload();
      setEditor(undefined);
      setState("saved");
      setMessage("应用配置已删除");
    } catch (error) {
      setState("error");
      setMessage(error instanceof Error ? error.message : "应用配置删除失败");
    }
  }

  return (
    <>
      {message ? (
        <p className={`gateway-channel-message integration-page-message${state === "error" ? " is-error" : ""}`} aria-live="polite">
          {state === "saved" ? <CheckCircle2 size={15} /> : state === "saving" || state === "deleting" ? <RefreshCw className="is-spinning" size={15} /> : null}
          {message}
        </p>
      ) : null}

      {snapshot.groups.map((group) => (
        <IntegrationGroup
          group={group}
          onAdd={() => addApplication(group.platform)}
          onEdit={editApplication}
          key={group.platform}
        />
      ))}

      {editor ? createPortal(
        <div className="gateway-channel-drawer-backdrop" onMouseDown={(event) => { if (event.target === event.currentTarget) closeEditor(); }}>
          <aside className="gateway-channel-drawer connector-drawer integration-drawer" ref={drawerRef} role="dialog" aria-modal="true" aria-labelledby="integration-editor-title">
            <div className="gateway-channel-editor__header">
              <div>
                <h3 id="integration-editor-title">{editor.mode === "create" ? `增加${platformGroup(editor.platform)?.displayName || ""}应用配置` : "编辑应用配置"}</h3>
                <p>填写应用名称、App ID、App Secret 和备注。</p>
              </div>
              <button type="button" data-drawer-autofocus onClick={closeEditor} disabled={state === "saving" || state === "deleting"} aria-label="关闭应用配置"><X size={17} /></button>
            </div>

            <div className="gateway-channel-drawer__body integration-editor-body">
              <section className="resource-detail-section integration-credential-form">
                <div className="resource-detail-section__header">
                  <strong>{platformGroup(editor.platform)?.displayName}开放平台应用</strong>
                  <span>{editor.mode === "create" ? "新增" : "编辑"}</span>
                </div>
                <div className="gateway-channel-fields connector-fields integration-form-fields">
                  <label className="field-label gateway-channel-field--wide">
                    <span>应用名称</span>
                    <input
                      value={editor.name}
                      onChange={(event) => setEditor((current) => current ? { ...current, name: event.target.value } : current)}
                      placeholder="填写便于识别的应用名称"
                      autoComplete="off"
                    />
                  </label>
                  <label className="field-label gateway-channel-field--wide">
                    <span>App ID</span>
                    <input
                      value={editor.appId}
                      onChange={(event) => setEditor((current) => current ? { ...current, appId: event.target.value } : current)}
                      placeholder="填写开放平台应用的 App ID"
                      autoComplete="off"
                    />
                  </label>
                  <label className="field-label gateway-channel-field--wide">
                    <span>App Secret</span>
                    <input
                      type="password"
                      value={editor.appSecret}
                      onChange={(event) => setEditor((current) => current ? { ...current, appSecret: event.target.value } : current)}
                      placeholder={editor.mode === "edit" ? "留空表示保留当前 Secret" : "填写开放平台应用的 App Secret"}
                      autoComplete="new-password"
                    />
                  </label>
                  <label className="field-label gateway-channel-field--wide">
                    <span>备注</span>
                    <textarea
                      value={editor.note}
                      onChange={(event) => setEditor((current) => current ? { ...current, note: event.target.value } : current)}
                      placeholder="补充应用用途或使用范围"
                      rows={3}
                    />
                  </label>
                </div>
              </section>
            </div>

            <div className="gateway-channel-editor__footer">
              {editor.mode === "edit" ? (
                <button className="gateway-remove-button integration-delete-button" type="button" onClick={deleteEditor} disabled={state === "saving" || state === "deleting"}>
                  <Trash2 size={15} />删除
                </button>
              ) : null}
              <button className="button button--secondary" type="button" onClick={closeEditor} disabled={state === "saving" || state === "deleting"}>取消</button>
              <button className="button button--primary" type="button" onClick={saveEditor} disabled={state === "saving" || state === "deleting"}>
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

function IntegrationGroup({
  group,
  onAdd,
  onEdit,
}: {
  group: EnterpriseIntegrationGroup;
  onAdd: () => void;
  onEdit: (application: IntegrationApplication) => void;
}) {
  const Icon = platformIcons[group.platform];
  return (
    <section className="portal-group gateway-resource-section integration-platform-group" aria-labelledby={`integration-${group.platform}-title`}>
      <header className="portal-group__header">
        <div className="integration-platform-heading">
          <span className={`gateway-channel-tile__icon integration-icon integration-icon--${group.platform}`}><Icon size={18} /></span>
          <div>
            <h2 id={`integration-${group.platform}-title`}>{group.displayName}</h2>
            <p>{group.description}</p>
          </div>
        </div>
        <button className="button button--secondary" type="button" onClick={onAdd}><Plus size={15} />增加应用配置</button>
      </header>
      <div className="gateway-channel-grid integration-application-grid">
        {group.applications.map((application) => (
          <article
            className="gateway-channel-tile integration-application-card is-clickable"
            key={application.id}
            tabIndex={0}
            onClick={() => onEdit(application)}
            onKeyDown={(event) => {
              if (event.key !== "Enter" && event.key !== " ") return;
              event.preventDefault();
              onEdit(application);
            }}
          >
            <div className="gateway-channel-tile__top">
              <span className={`gateway-channel-tile__icon integration-icon integration-icon--${group.platform}`}><Icon size={18} /></span>
              <div>
                <strong title={application.name}>{application.name}</strong>
                <small title={application.appId}>{application.appId}</small>
              </div>
            </div>
            <p className={`integration-application-note${application.note ? "" : " is-empty"}`} title={application.note || undefined}>
              {application.note || "暂无备注"}
            </p>
            <div className="integration-application-status">
              <span><LockKeyhole size={13} />密钥已保存</span>
              <span>更新于 {formatDateTime(application.updatedAt)}</span>
            </div>
          </article>
        ))}
        <button className="gateway-channel-add-card integration-add-card" type="button" onClick={onAdd}>
          <span><Plus size={19} /></span>
          <strong>增加应用配置</strong>
          <small>填写名称、凭据和备注</small>
        </button>
      </div>
    </section>
  );
}
