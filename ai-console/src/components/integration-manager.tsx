"use client";

import {
  Building2,
  CheckCircle2,
  ClipboardPaste,
  LockKeyhole,
  MessageSquareShare,
  Plus,
  RefreshCw,
  Save,
  Search,
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
import {
  parseFeishuPermissionExport,
  removeActionsRequiringPermission,
  selectActionsForImportedPermissions,
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
  actionIds: string[];
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
  const [actionQuery, setActionQuery] = useState("");
  const [state, setState] = useState<"idle" | "saving" | "saved" | "deleting" | "activating" | "error">(initialError ? "error" : "idle");
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
    const group = platformGroup(platform);
    setEditor({
      mode: "create",
      platform,
      name: "",
      appId: "",
      note: "",
      appSecret: "",
      actionIds: group?.defaultActionIds ?? [],
    });
    setActionQuery("");
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
      actionIds: application.actionIds,
    });
    setActionQuery("");
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
    const actionCatalog = platformGroup(editor.platform)?.actions ?? [];
    if (actionCatalog.length > 0 && editor.actionIds.length === 0) {
      setState("error");
      setMessage("至少选择一个 Action");
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
          actionIds: editor.actionIds,
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

  function toggleAction(actionId: string) {
    setEditor((current) => {
      if (!current) return current;
      const selected = new Set(current.actionIds);
      if (selected.has(actionId)) selected.delete(actionId);
      else selected.add(actionId);
      return { ...current, actionIds: [...selected] };
    });
  }

  function setFilteredActions(actionIds: string[], selected: boolean) {
    setEditor((current) => {
      if (!current) return current;
      const next = new Set(current.actionIds);
      actionIds.forEach((actionId) => selected ? next.add(actionId) : next.delete(actionId));
      return { ...current, actionIds: [...next] };
    });
  }

  function replaceActions(actionIds: string[]) {
    setEditor((current) => current ? { ...current, actionIds } : current);
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

  async function activateApplication(application: IntegrationApplication) {
    if (application.active || state === "activating") return;
    setState("activating");
    setMessage(`正在启用 ${application.name} 并同步 OAuth 客户端…`);
    try {
      await fetchJson(`/api/integrations/${encodeURIComponent(application.id)}/activate`, {
        method: "POST",
      });
      await reload();
      setState("saved");
      setMessage(`${application.name} 已设为该平台的启用应用`);
    } catch (error) {
      setState("error");
      setMessage(error instanceof Error ? error.message : "应用启用失败");
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
          onActivate={activateApplication}
          key={group.platform}
        />
      ))}

      {editor ? createPortal(
        <div className="gateway-channel-drawer-backdrop" onMouseDown={(event) => { if (event.target === event.currentTarget) closeEditor(); }}>
          <aside className="gateway-channel-drawer connector-drawer integration-drawer" ref={drawerRef} role="dialog" aria-modal="true" aria-labelledby="integration-editor-title">
            <div className="gateway-channel-editor__header">
              <div>
                <h3 id="integration-editor-title">{editor.mode === "create" ? `增加${platformGroup(editor.platform)?.displayName || ""}应用配置` : "编辑应用配置"}</h3>
                <p>配置应用凭据，并选择允许员工授权使用的 Action。</p>
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

              <IntegrationActionSelector
                group={platformGroup(editor.platform)}
                selectedActionIds={editor.actionIds}
                query={actionQuery}
                onQueryChange={setActionQuery}
                onToggle={toggleAction}
                onSetFiltered={setFilteredActions}
                onReplace={replaceActions}
              />
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

function IntegrationActionSelector({
  group,
  selectedActionIds,
  query,
  onQueryChange,
  onToggle,
  onSetFiltered,
  onReplace,
}: {
  group?: EnterpriseIntegrationGroup;
  selectedActionIds: string[];
  query: string;
  onQueryChange: (value: string) => void;
  onToggle: (actionId: string) => void;
  onSetFiltered: (actionIds: string[], selected: boolean) => void;
  onReplace: (actionIds: string[]) => void;
}) {
  const [permissionImportOpen, setPermissionImportOpen] = useState(false);
  const [permissionJson, setPermissionJson] = useState("");
  const [permissionImportFeedback, setPermissionImportFeedback] = useState<{
    tone: "success" | "warning" | "error";
    message: string;
  }>();

  if (!group?.actions.length) {
    return (
      <section className="resource-detail-section integration-action-section">
        <div className="resource-detail-section__header">
          <strong>授权 Action</strong>
          <span>暂不可用</span>
        </div>
        <div className="resource-detail-empty">当前平台尚未接入可配置的个人授权 Action。</div>
      </section>
    );
  }

  const selected = new Set(selectedActionIds);
  const normalizedQuery = query.trim().toLocaleLowerCase("zh-CN");
  const filtered = group.actions.filter((action) => (
    !normalizedQuery
    || action.name.toLocaleLowerCase("zh-CN").includes(normalizedQuery)
    || action.id.toLocaleLowerCase("zh-CN").includes(normalizedQuery)
    || (action.description || "").toLocaleLowerCase("zh-CN").includes(normalizedQuery)
    || action.providerPermissions.some((permission) => permission.toLocaleLowerCase("zh-CN").includes(normalizedQuery))
  ));
  const filteredIds = filtered.map((action) => action.id);
  const allFilteredSelected = filteredIds.length > 0 && filteredIds.every((actionId) => selected.has(actionId));
  const selectedActions = group.actions.filter((action) => selected.has(action.id));
  const scopes = [...new Set([
    ...group.oauthBaseScopes,
    ...selectedActions.flatMap((action) => action.providerPermissions),
  ])];
  const baseScopes = new Set(group.oauthBaseScopes);

  function importFeishuPermissions() {
    try {
      const imported = parseFeishuPermissionExport(permissionJson);
      const selection = selectActionsForImportedPermissions(
        group!.actions,
        imported.scopes,
        group!.oauthBaseScopes,
      );
      if (selection.actionIds.length === 0) {
        setPermissionImportFeedback({
          tone: "error",
          message: "没有找到权限要求完全被该 JSON 覆盖的 Action，请检查导出的应用权限。",
        });
        return;
      }
      onReplace(selection.actionIds);
      setPermissionImportFeedback({
        tone: selection.unmatchedScopes.length ? "warning" : "success",
        message: selection.unmatchedScopes.length
          ? `已勾选 ${selection.actionIds.length} 个 Action；另有 ${selection.unmatchedScopes.length} 个权限未映射到完整 Action。`
          : `已根据 ${imported.scopes.length} 个权限勾选 ${selection.actionIds.length} 个 Action。`,
      });
    } catch (error) {
      setPermissionImportFeedback({
        tone: "error",
        message: error instanceof Error ? error.message : "权限 JSON 导入失败",
      });
    }
  }

  return (
    <section className="resource-detail-section integration-action-section">
      <div className="resource-detail-section__header">
        <strong>授权 Action</strong>
        <span>{selected.size}/{group.actions.length} 已选择</span>
      </div>
      <p className="integration-action-help">
        员工绑定账号时，仅申请已选 Action 所需的权限。修改后，已经绑定的员工需要重新授权才能生效。
      </p>
      <div className="integration-action-toolbar">
        <label className="connector-search-input integration-action-search">
          <Search size={15} />
          <input
            value={query}
            onChange={(event) => onQueryChange(event.target.value)}
            placeholder="搜索 Action、说明或权限"
            aria-label="搜索 Action"
          />
        </label>
        <div className="integration-action-toolbar__actions">
          {group.platform === "feishu" ? (
            <button
              type="button"
              className={`button ${permissionImportOpen ? "button--primary" : "button--secondary"}`}
              onClick={() => {
                setPermissionImportOpen((open) => !open);
                setPermissionImportFeedback(undefined);
              }}
            >
              <ClipboardPaste size={14} />
              导入权限 JSON
            </button>
          ) : null}
          <button
            type="button"
            className="button button--secondary"
            disabled={filteredIds.length === 0}
            onClick={() => onSetFiltered(filteredIds, !allFilteredSelected)}
          >
            {allFilteredSelected ? "取消当前结果" : "选择当前结果"}
          </button>
        </div>
      </div>
      {permissionImportOpen ? (
        <div className="integration-permission-import">
          <div className="integration-permission-import__header">
            <div>
              <strong>导入飞书应用权限</strong>
              <span>粘贴“批量导入/导出权限”中复制的 JSON，导入结果将替换当前勾选。</span>
            </div>
            <button
              type="button"
              onClick={() => {
                setPermissionImportOpen(false);
                setPermissionImportFeedback(undefined);
              }}
              aria-label="关闭权限 JSON 导入"
            >
              <X size={14} />
            </button>
          </div>
          <textarea
            value={permissionJson}
            onChange={(event) => {
              setPermissionJson(event.target.value);
              setPermissionImportFeedback(undefined);
            }}
            placeholder={'{\n  "scopes": {\n    "tenant": ["base:record:read"],\n    "user": []\n  }\n}'}
            aria-label="飞书权限 JSON"
            spellCheck={false}
          />
          <div className="integration-permission-import__footer">
            <span className={permissionImportFeedback ? `is-${permissionImportFeedback.tone}` : ""} aria-live="polite">
              {permissionImportFeedback?.message || "只会勾选所需权限全部包含在导入 JSON 中的 Action。"}
            </span>
            <button className="button button--primary" type="button" onClick={importFeishuPermissions}>导入并替换勾选</button>
          </div>
        </div>
      ) : null}
      <div className="integration-scope-summary">
        <div>
          <strong>{scopes.length}</strong>
          <span>个 OAuth 权限</span>
        </div>
        <div className="integration-scope-tags">
          {scopes.map((scope) => (
            <span
              className={`integration-scope-tag${baseScopes.has(scope) ? " is-required" : ""}`}
              title={baseScopes.has(scope) ? "系统基础权限，无法移除" : undefined}
              key={scope}
            >
              <code>{scope}</code>
              {!baseScopes.has(scope) ? (
                <button
                  type="button"
                  onClick={() => onReplace(removeActionsRequiringPermission(group.actions, selectedActionIds, scope))}
                  aria-label={`移除权限 ${scope} 并取消相关 Action`}
                  title={`移除 ${scope}`}
                >
                  <X size={11} />
                </button>
              ) : null}
            </span>
          ))}
        </div>
      </div>
      <div className="integration-action-list">
        {filtered.map((action) => (
          <label className={selected.has(action.id) ? "is-selected" : ""} key={action.id}>
            <input
              type="checkbox"
              checked={selected.has(action.id)}
              onChange={() => onToggle(action.id)}
            />
            <span className="integration-action-copy">
              <strong className="integration-action-name">{action.name}</strong>
              <code className="integration-action-id">{action.id}</code>
              {action.description ? <small className="integration-action-description">{action.description}</small> : null}
              {action.providerPermissions.length ? (
                <span className="integration-action-permissions">
                  {action.providerPermissions.slice(0, 3).map((permission) => <em key={permission}>{permission}</em>)}
                  {action.providerPermissions.length > 3 ? <em>+{action.providerPermissions.length - 3}</em> : null}
                </span>
              ) : null}
            </span>
          </label>
        ))}
        {filtered.length === 0 ? <div className="integration-action-empty">没有匹配的 Action</div> : null}
      </div>
    </section>
  );
}

function IntegrationGroup({
  group,
  onAdd,
  onEdit,
  onActivate,
}: {
  group: EnterpriseIntegrationGroup;
  onAdd: () => void;
  onEdit: (application: IntegrationApplication) => void;
  onActivate: (application: IntegrationApplication) => void;
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
              {application.active ? (
                <span className="integration-active-badge"><CheckCircle2 size={12} />已启用</span>
              ) : (
                <button
                  className="integration-activate-button"
                  type="button"
                  onClick={(event) => {
                    event.stopPropagation();
                    onActivate(application);
                  }}
                >
                  设为启用
                </button>
              )}
            </div>
            <p className={`integration-application-note${application.note ? "" : " is-empty"}`} title={application.note || undefined}>
              {application.note || "暂无备注"}
            </p>
            <div className="integration-application-status">
              <span><LockKeyhole size={13} />密钥已保存 · {application.actionIds.length} Actions</span>
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
