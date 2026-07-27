"use client";

import {
  CheckCircle2,
  ChevronRight,
  ExternalLink,
  Globe2,
  KeyRound,
  LockKeyhole,
  Pencil,
  PlugZap,
  Plus,
  RefreshCw,
  Save,
  Search,
  ShieldCheck,
  Trash2,
  UserRound,
  X,
} from "lucide-react";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { createPortal } from "react-dom";

import {
  connectorActionIsAuthorized,
  connectorAuthLabels,
  type ConnectorAccessMode,
  type ConnectorAuthDefinition,
  type ConnectorAuthType,
  type ConnectorConnection,
  type ConnectorConnectionsSnapshot,
  type ConnectorCredentialField,
  type ConnectorOAuthClientField,
  type ConnectorOAuthConfig,
  type ConnectorProviderDetail,
  type ConnectorProviderSummary,
  type ConnectorProvidersPage,
} from "@/lib/control-plane/connectors";

type RequestState = "idle" | "loading" | "saving" | "saved" | "error";

type EditorState = {
  mode: "create" | "edit";
  original?: ConnectorConnection;
  provider?: ConnectorProviderDetail;
  authType?: ConnectorAuthType;
  connectionName: string;
  values: Record<string, string>;
  oauthConfig?: ConnectorOAuthConfig;
  oauthClientId: string;
  oauthClientSecret: string;
  oauthValues: Record<string, string>;
  reconfigureOAuth: boolean;
  loadingProvider: boolean;
};

type ConnectorDetailsState = {
  connection: ConnectorConnection;
  provider?: ConnectorProviderDetail;
  loading: boolean;
  error?: string;
};

type ConnectorActionView = "authorized" | "all";
type ConnectorAccessFilter = "all" | ConnectorAccessMode;

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

function providerSummary(provider: ConnectorProviderDetail): ConnectorProviderSummary {
  return {
    service: provider.service,
    displayName: provider.displayName,
    description: provider.description,
    categories: provider.categories,
    authTypes: provider.authTypes,
    iconUrl: provider.iconUrl,
    actionCount: provider.actionCount,
  };
}

function authDefinition(provider: ConnectorProviderDetail | undefined, type: ConnectorAuthType | undefined) {
  return provider?.auth.find((auth) => auth.type === type);
}

function connectionFields(auth: ConnectorAuthDefinition | undefined): ConnectorCredentialField[] {
  if (!auth) return [];
  if (auth.type === "api_key") {
    return [{
      key: "apiKey",
      label: auth.label || "API Key",
      inputType: "password",
      required: true,
      secret: true,
      placeholder: auth.placeholder,
      description: auth.description,
    }, ...auth.extraFields];
  }
  return auth.type === "custom_credential" ? auth.fields : [];
}

function initialValues(fields: Array<ConnectorCredentialField | ConnectorOAuthClientField>) {
  return Object.fromEntries(fields.map((field) => [field.key, "defaultValue" in field ? field.defaultValue || "" : ""]));
}

function ProviderIcon({ provider }: { provider?: ConnectorProviderSummary }) {
  const [failed, setFailed] = useState(false);
  if (provider?.iconUrl && !failed) {
    // Provider icons are arbitrary upstream URLs, so Next Image cannot maintain a finite host allowlist.
    // eslint-disable-next-line @next/next/no-img-element
    return <img src={provider.iconUrl} alt="" referrerPolicy="no-referrer" onError={() => setFailed(true)} />;
  }
  return <PlugZap size={18} />;
}

function ConnectorCard({
  connection,
  provider,
  deleting,
  onView,
  onEdit,
  onDisconnect,
}: {
  connection: ConnectorConnection;
  provider?: ConnectorProviderSummary;
  deleting: boolean;
  onView: (connection: ConnectorConnection) => void;
  onEdit: (connection: ConnectorConnection) => void;
  onDisconnect: (connection: ConnectorConnection) => void;
}) {
  const accountBound = connection.accessMode === "account_bound";
  const accessLabel = connection.accessMode === "no_auth"
    ? "无需认证"
    : accountBound
      ? "用户绑定"
      : "全局使用";

  return (
    <article
      className={`gateway-channel-tile is-clickable is-enabled${connection.virtual ? " is-system-managed" : ""}`}
      tabIndex={0}
      aria-label={`查看${provider?.displayName || connection.service}详情`}
      onClick={() => onView(connection)}
      onKeyDown={(event) => {
        if (event.target !== event.currentTarget || (event.key !== "Enter" && event.key !== " ")) return;
        event.preventDefault();
        onView(connection);
      }}
    >
      <div className="gateway-channel-tile__top">
        <span className="gateway-channel-tile__icon connector-provider-icon" aria-hidden="true"><ProviderIcon provider={provider} /></span>
        <div><strong>{provider?.displayName || connection.service}</strong><small>{connection.connectionName}</small></div>
        <span className={`gateway-channel-state is-enabled${connection.accessMode !== "global" ? " is-managed" : ""}`}>{accessLabel}</span>
      </div>
      <p className="gateway-channel-endpoint" title={connection.profile.accountId}>{connection.profile.displayName}</p>
      <div className="gateway-channel-metrics">
        <span><LockKeyhole size={13} />{connectorAuthLabels[connection.authType]}</span>
        <span>{connection.default ? "默认连接" : "命名连接"}</span>
      </div>
      <div className="gateway-model-tags" aria-label="授权范围">
        {connection.profile.grantedScopes.slice(0, 3).map((scope) => <span key={scope}>{scope}</span>)}
        {connection.profile.grantedScopes.length > 3 ? <span>+{connection.profile.grantedScopes.length - 3}</span> : null}
        {connection.profile.grantedScopes.length === 0 ? <em>{provider?.actionCount || 0} 个可用 Action</em> : null}
      </div>
      <div className="gateway-channel-tile__actions" onClick={(event) => event.stopPropagation()}>
        {connection.virtual
          ? <span className="gateway-managed-lock"><ShieldCheck size={14} />无需配置</span>
          : accountBound
            ? <span className="gateway-managed-lock"><UserRound size={14} />员工专属连接</span>
            : <span className="gateway-managed-lock"><CheckCircle2 size={14} />凭据已保存</span>}
        {connection.accessMode === "global" ? <button className="button button--secondary" type="button" onClick={() => onEdit(connection)}><Pencil size={14} />编辑</button> : null}
        {connection.accessMode === "global" ? <button className="gateway-remove-button" type="button" onClick={() => onDisconnect(connection)} disabled={deleting} aria-label={`断开${connection.connectionName}`}><Trash2 size={15} /></button> : null}
      </div>
    </article>
  );
}

export function ConnectorManager({
  initialConnections,
  initialProviders,
  initialConnectionProviders,
  initialError,
}: {
  initialConnections: ConnectorConnection[];
  initialProviders: ConnectorProvidersPage;
  initialConnectionProviders: ConnectorProviderSummary[];
  initialError?: string;
}) {
  const [connections, setConnections] = useState(initialConnections);
  const [providerPage, setProviderPage] = useState(initialProviders);
  const [knownProviders, setKnownProviders] = useState<ConnectorProviderSummary[]>(() => {
    const map = new Map([...initialProviders.items, ...initialConnectionProviders].map((provider) => [provider.service, provider]));
    return Array.from(map.values());
  });
  const [providerQuery, setProviderQuery] = useState("");
  const [providerCategory, setProviderCategory] = useState("");
  const [providerAuthType, setProviderAuthType] = useState("");
  const [providerLoading, setProviderLoading] = useState(false);
  const [editor, setEditor] = useState<EditorState>();
  const [details, setDetails] = useState<ConnectorDetailsState>();
  const [detailsActionView, setDetailsActionView] = useState<ConnectorActionView>("authorized");
  const [accessFilter, setAccessFilter] = useState<ConnectorAccessFilter>("all");
  const [state, setState] = useState<RequestState>(initialError ? "error" : "idle");
  const [message, setMessage] = useState(initialError || "");
  const [deletingId, setDeletingId] = useState<string>();
  const drawerRef = useRef<HTMLElement>(null);
  const oauthWatcherRef = useRef<ReturnType<typeof setInterval> | undefined>(undefined);

  const providerByService = useMemo(
    () => new Map(knownProviders.map((provider) => [provider.service, provider])),
    [knownProviders],
  );
  const accountBoundConnections = useMemo(
    () => connections.filter((connection) => connection.accessMode === "account_bound"),
    [connections],
  );
  const noAuthConnections = useMemo(
    () => connections.filter((connection) => connection.accessMode === "no_auth"),
    [connections],
  );
  const globalConnections = useMemo(
    () => connections.filter((connection) => connection.accessMode === "global"),
    [connections],
  );
  const detailActions = details?.provider?.actions ?? [];
  const authorizedDetailActions = details
    ? detailActions.filter((action) => connectorActionIsAuthorized(details.connection, action))
    : [];
  const visibleDetailActions = detailsActionView === "authorized" ? authorizedDetailActions : detailActions;
  const selectingProvider = Boolean(editor && !editor.provider && !editor.loadingProvider);
  const drawerOpen = Boolean(editor || details);
  const drawerFocusKey = editor
    ? `editor:${editor.original?.id || editor.provider?.service || "new"}`
    : details ? `details:${details.connection.id}` : undefined;

  const closeEditor = useCallback(() => {
    setEditor(undefined);
    setProviderQuery("");
    setProviderCategory("");
    setProviderAuthType("");
  }, []);

  const closeDetails = useCallback(() => setDetails(undefined), []);
  const closeActiveDrawer = useCallback(() => {
    closeEditor();
    closeDetails();
  }, [closeDetails, closeEditor]);

  useEffect(() => () => {
    if (oauthWatcherRef.current) clearInterval(oauthWatcherRef.current);
  }, []);

  useEffect(() => {
    if (!drawerOpen) return;
    const previouslyFocused = document.activeElement instanceof HTMLElement ? document.activeElement : undefined;
    const previousOverflow = document.body.style.overflow;
    document.body.style.overflow = "hidden";
    const frame = requestAnimationFrame(() => {
      drawerRef.current?.querySelector<HTMLElement>("[data-drawer-autofocus]")?.focus();
    });
    function handleKeyDown(event: KeyboardEvent) {
      if (event.key === "Escape") {
        closeActiveDrawer();
        return;
      }
      if (event.key !== "Tab" || !drawerRef.current) return;
      const focusable = Array.from(drawerRef.current.querySelectorAll<HTMLElement>(
        "button:not([disabled]), input:not([disabled]), select:not([disabled]), textarea:not([disabled]), [href]",
      ));
      const first = focusable[0];
      const last = focusable.at(-1);
      if (!first || !last) return;
      if (event.shiftKey && document.activeElement === first) {
        event.preventDefault();
        last.focus();
      } else if (!event.shiftKey && document.activeElement === last) {
        event.preventDefault();
        first.focus();
      }
    }
    document.addEventListener("keydown", handleKeyDown);
    return () => {
      cancelAnimationFrame(frame);
      document.removeEventListener("keydown", handleKeyDown);
      document.body.style.overflow = previousOverflow;
      previouslyFocused?.focus();
    };
  }, [closeActiveDrawer, drawerFocusKey, drawerOpen]);

  useEffect(() => {
    if (!selectingProvider) return;
    const controller = new AbortController();
    const timer = setTimeout(async () => {
      setProviderLoading(true);
      const params = new URLSearchParams({ limit: "24" });
      if (providerQuery.trim()) params.set("query", providerQuery.trim());
      if (providerCategory) params.set("category", providerCategory);
      if (providerAuthType) params.set("authType", providerAuthType);
      try {
        const page = await fetchJson<ConnectorProvidersPage>(`/api/open-connector/providers?${params}`, { signal: controller.signal });
        setProviderPage(page);
      } catch (error) {
        if (!controller.signal.aborted) {
          setState("error");
          setMessage(error instanceof Error ? error.message : "读取 Connector 目录失败");
        }
      } finally {
        if (!controller.signal.aborted) setProviderLoading(false);
      }
    }, 250);
    return () => {
      clearTimeout(timer);
      controller.abort();
    };
  }, [providerAuthType, providerCategory, providerQuery, selectingProvider]);

  function patchEditor(patch: Partial<EditorState>) {
    setEditor((current) => current ? { ...current, ...patch } : current);
    setState("idle");
    setMessage("");
  }

  async function reloadConnections() {
    const snapshot = await fetchJson<ConnectorConnectionsSnapshot>("/api/open-connector/connections");
    setConnections(snapshot.connections);
    return snapshot.connections;
  }

  function addConnector() {
    closeDetails();
    setEditor({
      mode: "create",
      connectionName: "default",
      values: {},
      oauthClientId: "",
      oauthClientSecret: "",
      oauthValues: {},
      reconfigureOAuth: false,
      loadingProvider: false,
    });
    setState("idle");
    setMessage("");
  }

  async function loadOAuthConfig(service: string) {
    return fetchJson<ConnectorOAuthConfig>(`/api/open-connector/oauth-configs/${encodeURIComponent(service)}`);
  }

  async function selectProvider(summary: ConnectorProviderSummary) {
    patchEditor({ loadingProvider: true });
    try {
      const provider = await fetchJson<ConnectorProviderDetail>(`/api/open-connector/providers/${encodeURIComponent(summary.service)}`);
      const authType = provider.auth[0]?.type;
      const auth = authDefinition(provider, authType);
      const oauthConfig = authType === "oauth2" ? await loadOAuthConfig(provider.service) : undefined;
      setKnownProviders((current) => {
        const map = new Map(current.map((item) => [item.service, item]));
        map.set(provider.service, providerSummary(provider));
        return Array.from(map.values());
      });
      setEditor((current) => current ? {
        ...current,
        provider,
        authType,
        values: initialValues(connectionFields(auth)),
        oauthConfig,
        oauthClientId: oauthConfig?.clientId || "",
        oauthClientSecret: "",
        oauthValues: initialValues(auth?.type === "oauth2" ? auth.clientConfigFields : []),
        reconfigureOAuth: Boolean(authType === "oauth2" && !oauthConfig?.configured),
        loadingProvider: false,
      } : current);
    } catch (error) {
      patchEditor({ loadingProvider: false });
      setState("error");
      setMessage(error instanceof Error ? error.message : "读取 Connector 配置失败");
    }
  }

  async function editConnector(connection: ConnectorConnection) {
    closeDetails();
    setEditor({
      mode: "edit",
      original: connection,
      authType: connection.authType,
      connectionName: connection.connectionName,
      values: {},
      oauthClientId: "",
      oauthClientSecret: "",
      oauthValues: {},
      reconfigureOAuth: false,
      loadingProvider: true,
    });
    setState("idle");
    setMessage("");
    try {
      const provider = await fetchJson<ConnectorProviderDetail>(`/api/open-connector/providers/${encodeURIComponent(connection.service)}`);
      const auth = authDefinition(provider, connection.authType);
      const oauthConfig = connection.authType === "oauth2" ? await loadOAuthConfig(provider.service) : undefined;
      setKnownProviders((current) => {
        const map = new Map(current.map((item) => [item.service, item]));
        map.set(provider.service, providerSummary(provider));
        return Array.from(map.values());
      });
      setEditor((current) => current?.original?.id === connection.id ? {
        ...current,
        provider,
        values: initialValues(connectionFields(auth)),
        oauthConfig,
        oauthClientId: oauthConfig?.clientId || "",
        oauthValues: initialValues(auth?.type === "oauth2" ? auth.clientConfigFields : []),
        reconfigureOAuth: Boolean(connection.authType === "oauth2" && !oauthConfig?.configured),
        loadingProvider: false,
      } : current);
    } catch (error) {
      setState("error");
      setMessage(error instanceof Error ? error.message : "读取连接配置失败");
      patchEditor({ loadingProvider: false });
    }
  }

  async function changeAuthType(type: ConnectorAuthType) {
    if (!editor?.provider) return;
    const auth = authDefinition(editor.provider, type);
    patchEditor({
      authType: type,
      values: initialValues(connectionFields(auth)),
      oauthConfig: undefined,
      oauthClientId: "",
      oauthClientSecret: "",
      oauthValues: initialValues(auth?.type === "oauth2" ? auth.clientConfigFields : []),
      reconfigureOAuth: false,
    });
    if (type === "oauth2") {
      setState("loading");
      try {
        const config = await loadOAuthConfig(editor.provider.service);
        patchEditor({
          oauthConfig: config,
          oauthClientId: config.clientId || "",
          reconfigureOAuth: !config.configured,
        });
      } catch (error) {
        setState("error");
        setMessage(error instanceof Error ? error.message : "读取 OAuth 配置失败");
      }
    }
  }

  function validateFields(fields: ConnectorCredentialField[], values: Record<string, string>) {
    const missing = fields.find((field) => field.required && !values[field.key]?.trim());
    if (missing) throw new Error(`${missing.label} 不能为空`);
    const invalidJson = fields.find((field) => field.inputType === "json" && values[field.key]?.trim() && (() => {
      try { JSON.parse(values[field.key]); return false; } catch { return true; }
    })());
    if (invalidJson) throw new Error(`${invalidJson.label} 不是有效的 JSON`);
  }

  async function saveCredentialConnection() {
    if (!editor?.provider || !editor.authType || editor.authType === "oauth2") return;
    const auth = authDefinition(editor.provider, editor.authType);
    const fields = connectionFields(auth);
    validateFields(fields, editor.values);
    if (editor.mode === "create" && connections.some((connection) => connection.service === editor.provider?.service && connection.connectionName === editor.connectionName)) {
      throw new Error("同名连接已经存在，请直接编辑已有卡片");
    }
    const payload = await fetchJson<{ connection: ConnectorConnection; message: string }>(
      `/api/open-connector/connections/${encodeURIComponent(editor.provider.service)}`,
      {
        method: "PUT",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          connectionName: editor.connectionName,
          authType: editor.authType,
          values: Object.fromEntries(fields.map((field) => [field.key, editor.values[field.key] || ""])),
        }),
      },
    );
    await reloadConnections();
    closeEditor();
    setState("saved");
    setMessage(payload.message || "连接已保存");
  }

  async function saveOAuthAndAuthorize() {
    if (!editor?.provider || editor.authType !== "oauth2") return;
    const popup = window.open("about:blank", `connector-oauth-${editor.provider.service}`, "popup,width=720,height=760");
    if (!popup) throw new Error("浏览器阻止了授权窗口，请允许弹窗后重试");
    popup.document.title = "正在打开授权页面";
    popup.document.body.textContent = "正在准备 OAuth 授权…";
    try {
      let oauthConfig = editor.oauthConfig;
      if (!oauthConfig?.configured || editor.reconfigureOAuth) {
        const oauth = authDefinition(editor.provider, "oauth2");
        const fields = oauth?.type === "oauth2" ? oauth.clientConfigFields : [];
        validateFields(fields, editor.oauthValues);
        if (!editor.oauthClientId.trim()) throw new Error("Client ID 不能为空");
        if (!editor.oauthClientSecret.trim()) throw new Error("Client Secret 不能为空");
        const extra: Record<string, string> = {};
        const secretExtra: Record<string, string> = {};
        for (const field of fields) {
          const target = field.location === "secretExtra" || field.secret ? secretExtra : extra;
          target[field.key] = editor.oauthValues[field.key] || "";
        }
        oauthConfig = await fetchJson<ConnectorOAuthConfig>(
          `/api/open-connector/oauth-configs/${encodeURIComponent(editor.provider.service)}`,
          {
            method: "PUT",
            headers: { "content-type": "application/json" },
            body: JSON.stringify({
              clientId: editor.oauthClientId,
              clientSecret: editor.oauthClientSecret,
              extra,
              secretExtra,
            }),
          },
        );
      }
      const authorization = await fetchJson<{ authorizationUrl: string }>("/api/open-connector/oauth-authorizations", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ service: editor.provider.service, connectionName: editor.connectionName }),
      });
      popup.location.replace(authorization.authorizationUrl);
      patchEditor({ oauthConfig, oauthClientSecret: "", reconfigureOAuth: false });
      setState("loading");
      setMessage("请在新窗口完成 OAuth 授权；窗口关闭后将自动刷新连接。 ");
      if (oauthWatcherRef.current) clearInterval(oauthWatcherRef.current);
      oauthWatcherRef.current = setInterval(async () => {
        if (!popup.closed) return;
        if (oauthWatcherRef.current) clearInterval(oauthWatcherRef.current);
        oauthWatcherRef.current = undefined;
        try {
          const latest = await reloadConnections();
          const connected = latest.some((connection) => connection.service === editor.provider?.service && connection.connectionName === editor.connectionName && connection.configured);
          if (!connected) throw new Error("未检测到授权结果，请确认授权已经完成");
          closeEditor();
          setState("saved");
          setMessage("OAuth 授权成功，连接已加入列表。 ");
        } catch (error) {
          setState("error");
          setMessage(error instanceof Error ? error.message : "刷新 OAuth 连接失败");
        }
      }, 1_000);
    } catch (error) {
      popup.close();
      throw error;
    }
  }

  async function saveEditor() {
    if (!editor?.provider || !editor.authType) return;
    if (!editor.connectionName.trim()) {
      setState("error");
      setMessage("连接名称不能为空");
      return;
    }
    setState("saving");
    setMessage(editor.authType === "oauth2" ? "正在准备 OAuth 授权…" : "正在验证并保存连接…");
    try {
      if (editor.authType === "oauth2") await saveOAuthAndAuthorize();
      else await saveCredentialConnection();
    } catch (error) {
      setState("error");
      setMessage(error instanceof Error ? error.message : "保存连接失败");
    }
  }

  async function disconnect(connection: ConnectorConnection) {
    if (connection.virtual || !window.confirm(`确认断开 ${connection.service} / ${connection.connectionName}？`)) return;
    setDeletingId(connection.id);
    setState("loading");
    setMessage(`正在断开 ${connection.connectionName}…`);
    try {
      await fetchJson(`/api/open-connector/connections/${encodeURIComponent(connection.service)}`, {
        method: "DELETE",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ connectionName: connection.connectionName }),
      });
      await reloadConnections();
      setState("saved");
      setMessage("连接已断开");
    } catch (error) {
      setState("error");
      setMessage(error instanceof Error ? error.message : "断开连接失败");
    } finally {
      setDeletingId(undefined);
    }
  }

  async function viewConnector(connection: ConnectorConnection) {
    setDetailsActionView("authorized");
    setDetails({ connection, loading: true });
    try {
      const provider = await fetchJson<ConnectorProviderDetail>(`/api/open-connector/providers/${encodeURIComponent(connection.service)}`);
      setKnownProviders((current) => {
        const map = new Map(current.map((item) => [item.service, item]));
        map.set(provider.service, providerSummary(provider));
        return Array.from(map.values());
      });
      setDetails((current) => current?.connection.id === connection.id ? { connection, provider, loading: false } : current);
    } catch (error) {
      setDetails((current) => current?.connection.id === connection.id ? {
        connection,
        loading: false,
        error: error instanceof Error ? error.message : "读取 Connector 详情失败",
      } : current);
    }
  }

  const selectedAuth = authDefinition(editor?.provider, editor?.authType);
  const selectedFields = connectionFields(selectedAuth);
  const oauthFields = selectedAuth?.type === "oauth2" ? selectedAuth.clientConfigFields : [];

  return (
    <>
      <section className="model-gateway-summary connector-summary" aria-label="连接器摘要">
        <article><span><ShieldCheck size={17} /></span><div><strong>{noAuthConnections.length}</strong><small>个无需认证连接</small></div></article>
        <article><span><UserRound size={17} /></span><div><strong>{accountBoundConnections.length}</strong><small>个用户绑定连接</small></div></article>
        <article><span><Globe2 size={17} /></span><div><strong>{globalConnections.length}</strong><small>个全局连接</small></div></article>
      </section>

      <nav className="connector-access-filter" aria-label="连接器使用范围筛选">
        {([
          ["all", "全部", connections.length],
          ["no_auth", "无需认证", noAuthConnections.length],
          ["account_bound", "用户绑定", accountBoundConnections.length],
          ["global", "全局使用", globalConnections.length],
        ] as const).map(([value, label, count]) => (
          <button
            className={accessFilter === value ? "is-active" : ""}
            type="button"
            aria-pressed={accessFilter === value}
            onClick={() => setAccessFilter(value)}
            key={value}
          >
            {label}<span>({count})</span>
          </button>
        ))}
      </nav>

      {message ? <p className={`gateway-channel-message${state === "error" ? " is-error" : ""}`} aria-live="polite">{state === "saved" ? <CheckCircle2 size={15} /> : null}{message}</p> : null}

      {accessFilter === "all" || accessFilter === "no_auth" ? <section className="portal-group gateway-resource-section" aria-labelledby="connector-no-auth-title">
        <header className="portal-group__header">
          <div>
            <h2 id="connector-no-auth-title">无需认证</h2>
            <p>无需账号授权或凭据，OpenConnector 可直接调用。</p>
          </div>
          <span className="gateway-channel-state is-managed">{noAuthConnections.length} 个 Connector</span>
        </header>
        <div className="gateway-channel-grid connector-card-grid">
          {noAuthConnections.map((connection) => (
            <ConnectorCard
              connection={connection}
              provider={providerByService.get(connection.service)}
              deleting={deletingId === connection.id}
              onView={viewConnector}
              onEdit={editConnector}
              onDisconnect={disconnect}
              key={connection.id}
            />
          ))}
          {noAuthConnections.length === 0 ? (
            <div className="connector-empty-group">
              <ShieldCheck size={20} />
              <strong>暂无无需认证的 Connector</strong>
              <span>OpenConnector 提供后会自动显示在这里。</span>
            </div>
          ) : null}
        </div>
      </section> : null}

      {accessFilter === "all" || accessFilter === "account_bound" ? <section className="portal-group gateway-resource-section" aria-labelledby="connector-account-bound-title">
        <header className="portal-group__header">
          <div>
            <h2 id="connector-account-bound-title">用户绑定</h2>
            <p>由员工完成个人账号授权，仅对绑定身份开放。</p>
          </div>
          <span className="gateway-channel-state is-managed">{accountBoundConnections.length} 个 Connector</span>
        </header>
        <div className="gateway-channel-grid connector-card-grid">
          {accountBoundConnections.map((connection) => (
            <ConnectorCard
              connection={connection}
              provider={providerByService.get(connection.service)}
              deleting={deletingId === connection.id}
              onView={viewConnector}
              onEdit={editConnector}
              onDisconnect={disconnect}
              key={connection.id}
            />
          ))}
          {accountBoundConnections.length === 0 ? (
            <div className="connector-empty-group">
              <UserRound size={20} />
              <strong>暂无用户绑定的 Connector</strong>
              <span>员工完成账号绑定后会自动显示在这里。</span>
            </div>
          ) : null}
        </div>
      </section> : null}

      {accessFilter === "all" || accessFilter === "global" ? <section className="portal-group gateway-resource-section" aria-labelledby="connector-global-title">
        <header className="portal-group__header">
          <div>
            <h2 id="connector-global-title">全局使用</h2>
            <p>由管理员统一配置，可供基础设施中的授权用户共享使用。</p>
          </div>
          <div className="gateway-resource-actions">
            <span className="gateway-channel-state is-managed">{globalConnections.length} 个 Connector</span>
            <button className="button button--secondary" type="button" onClick={addConnector} disabled={state === "saving"}><Plus size={15} />添加连接器</button>
          </div>
        </header>
        <div className="gateway-channel-grid connector-card-grid">
          {globalConnections.map((connection) => (
            <ConnectorCard
              connection={connection}
              provider={providerByService.get(connection.service)}
              deleting={deletingId === connection.id}
              onView={viewConnector}
              onEdit={editConnector}
              onDisconnect={disconnect}
              key={connection.id}
            />
          ))}
          <button className="gateway-channel-add-card" type="button" onClick={addConnector} disabled={state === "saving"}>
            <span><Plus size={19} /></span><strong>添加连接器</strong><small>从 OpenConnector 动态读取配置</small>
          </button>
        </div>
      </section> : null}

      {details ? createPortal(
        <div className="gateway-channel-drawer-backdrop" onMouseDown={(event) => { if (event.target === event.currentTarget) closeDetails(); }}>
          <aside className="gateway-channel-drawer connector-drawer" ref={drawerRef} role="dialog" aria-modal="true" aria-labelledby="connector-details-title">
            <div className="gateway-channel-editor__header">
              <div><span className="card-kicker">Connector 详情</span><h3 id="connector-details-title">{details.provider?.displayName || providerByService.get(details.connection.service)?.displayName || details.connection.service}</h3><p>只读展示连接配置与授权信息，默认查看当前连接已授权的 Action。</p></div>
              <button type="button" data-drawer-autofocus onClick={closeDetails} aria-label="关闭 Connector 详情"><X size={17} /></button>
            </div>

            <div className="gateway-channel-drawer__body resource-detail-body">
              <section className="resource-detail-section">
                <div className="resource-detail-section__header"><strong>连接信息</strong><span className={`gateway-channel-state is-enabled${details.connection.virtual ? " is-managed" : ""}`}>{details.connection.virtual ? "系统可用" : details.connection.configured ? "已连接" : "未配置"}</span></div>
                <dl className="resource-detail-grid">
                  <div><dt>Service ID</dt><dd className="is-mono">{details.connection.service}</dd></div>
                  <div><dt>连接名称</dt><dd className="is-mono">{details.connection.connectionName}</dd></div>
                  <div><dt>认证方式</dt><dd>{connectorAuthLabels[details.connection.authType]}</dd></div>
                  <div><dt>使用范围</dt><dd>{details.connection.accessMode === "no_auth" ? "无需认证" : details.connection.accessMode === "account_bound" ? "用户绑定" : "全局使用"}</dd></div>
                  <div><dt>连接类型</dt><dd>{details.connection.default ? "默认连接" : "命名连接"}</dd></div>
                  <div><dt>账号名称</dt><dd>{details.connection.profile.displayName}</dd></div>
                  <div><dt>凭据状态</dt><dd>{details.connection.virtual ? "无需凭据" : details.connection.configured ? "服务端已保存" : "未配置"}</dd></div>
                  <div className="is-wide"><dt>账号 ID</dt><dd className="is-mono">{details.connection.profile.accountId}</dd></div>
                </dl>
                {details.provider?.description ? <p className="resource-detail-description">{details.provider.description}</p> : null}
                <div className="resource-detail-filter-groups">
                  <div><span>分类</span><p>{details.provider?.categories.join("、") || "未分类"}</p></div>
                  <div><span>授权范围</span><p>{details.connection.profile.grantedScopes.join("、") || "无需授权范围"}</p></div>
                </div>
              </section>

              <section className="resource-detail-section">
                <div className="resource-detail-section__header">
                  <strong>Actions</strong>
                  <span>{details.loading ? "读取中" : `${authorizedDetailActions.length}/${detailActions.length} 已授权`}</span>
                </div>
                {!details.loading && !details.error && detailActions.length ? (
                  <div className="connector-action-view" role="group" aria-label="Action 展示范围">
                    <button
                      className={detailsActionView === "authorized" ? "is-active" : ""}
                      type="button"
                      aria-pressed={detailsActionView === "authorized"}
                      onClick={() => setDetailsActionView("authorized")}
                    >
                      已授权 <span>{authorizedDetailActions.length}</span>
                    </button>
                    <button
                      className={detailsActionView === "all" ? "is-active" : ""}
                      type="button"
                      aria-pressed={detailsActionView === "all"}
                      onClick={() => setDetailsActionView("all")}
                    >
                      全部 <span>{detailActions.length}</span>
                    </button>
                  </div>
                ) : null}
                {details.loading ? (
                  <div className="gateway-mcp-tools-state"><RefreshCw className="is-spinning" size={18} /><strong>正在读取 Actions</strong><p>正在从 OpenConnector 获取完整 Action 定义…</p></div>
                ) : details.error ? (
                  <div className="gateway-mcp-tools-state is-error"><PlugZap size={18} /><strong>Action 读取失败</strong><p>{details.error}</p></div>
                ) : visibleDetailActions.length ? (
                  <div className="gateway-mcp-tool-list connector-action-list">
                    {visibleDetailActions.map((action, index) => (
                      <article key={action.id}>
                        <span>{String(index + 1).padStart(2, "0")}</span>
                        <div>
                          <strong>{action.id}</strong>
                          <p>{action.description || "暂无 Action 说明"}</p>
                          <div className="connector-action-meta">
                            <span>{action.execution?.needsCredential ? "需要凭据" : "无需凭据"}</span>
                            <span>{action.requiredScopes.length ? `${action.requiredScopes.length} 个 Scope` : "无额外 Scope"}</span>
                          </div>
                          <details className="resource-schema-details">
                            <summary>查看输入 / 输出 Schema</summary>
                            <div><strong>Input</strong><pre>{JSON.stringify(action.inputSchema || {}, null, 2)}</pre></div>
                            <div><strong>Output</strong><pre>{JSON.stringify(action.outputSchema || {}, null, 2)}</pre></div>
                          </details>
                        </div>
                      </article>
                    ))}
                  </div>
                ) : detailActions.length ? (
                  <div className="resource-detail-empty">当前连接没有已授权 Action，可切换到“全部”查看完整目录。</div>
                ) : <div className="resource-detail-empty">该 Connector 当前没有公开 Action。</div>}
              </section>
            </div>

            <div className="gateway-channel-editor__footer"><button className="button button--primary" type="button" onClick={closeDetails}>关闭</button></div>
          </aside>
        </div>,
        document.body,
      ) : null}

      {editor ? createPortal(
        <div className="gateway-channel-drawer-backdrop" onMouseDown={(event) => { if (event.target === event.currentTarget && state !== "saving") closeEditor(); }}>
          <aside className="gateway-channel-drawer connector-drawer" ref={drawerRef} role="dialog" aria-modal="true" aria-labelledby="connector-editor-title">
            <div className="gateway-channel-editor__header">
              <div><span className="card-kicker">连接器配置</span><h3 id="connector-editor-title">{editor.mode === "create" ? "添加连接器" : `编辑 ${editor.provider?.displayName || editor.original?.service || "连接"}`}</h3><p>{editor.mode === "create" ? "成功保存或完成 OAuth 授权后才会加入卡片列表。" : "敏感凭据不会回显；保存前需要重新填写当前认证方式的必填字段。"}</p></div>
              <button type="button" data-drawer-autofocus onClick={closeEditor} disabled={state === "saving"} aria-label="关闭连接器配置"><X size={17} /></button>
            </div>

            <div className="gateway-channel-drawer__body connector-drawer__body">
              {editor.loadingProvider ? <div className="connector-picker-state"><RefreshCw className="is-spinning" size={20} /><strong>正在读取 Connector 配置</strong></div> : null}

              {selectingProvider ? (
                <div className="connector-provider-picker">
                  <div className="connector-provider-filters">
                    <label className="field-label connector-provider-search"><span>选择 Connector</span><span className="connector-search-input"><Search size={15} /><input value={providerQuery} onChange={(event) => setProviderQuery(event.target.value)} placeholder="搜索名称或 Service ID" /></span></label>
                    <label className="field-label"><span>分类</span><select value={providerCategory} onChange={(event) => setProviderCategory(event.target.value)}><option value="">全部分类</option>{providerPage.categories.map((category) => <option value={category} key={category}>{category}</option>)}</select></label>
                    <label className="field-label"><span>连接方式</span><select value={providerAuthType} onChange={(event) => setProviderAuthType(event.target.value)}><option value="">全部方式</option>{providerPage.authTypes.map((type) => <option value={type} key={type}>{connectorAuthLabels[type]}</option>)}</select></label>
                  </div>
                  <p className="connector-picker-count">找到 {providerPage.total} 个 Connector{providerPage.total > providerPage.items.length ? `，当前显示前 ${providerPage.items.length} 个` : ""}</p>
                  <div className="connector-provider-results" aria-busy={providerLoading}>
                    {providerLoading ? <div className="connector-picker-state"><RefreshCw className="is-spinning" size={18} /><span>正在搜索…</span></div> : null}
                    {!providerLoading && providerPage.items.map((provider) => (
                      <button type="button" key={provider.service} onClick={() => selectProvider(provider)}>
                        <span className="connector-result-icon"><ProviderIcon provider={provider} /></span>
                        <span className="connector-result-copy"><strong>{provider.displayName}</strong><small>{provider.service} · {provider.categories.slice(0, 2).join(" / ") || "未分类"}</small></span>
                        <span className="connector-result-meta">{provider.authTypes.map((type) => connectorAuthLabels[type]).join(" / ")}<small>{provider.actionCount} Actions</small></span>
                        <ChevronRight size={16} />
                      </button>
                    ))}
                    {!providerLoading && providerPage.items.length === 0 ? <div className="connector-picker-state"><Search size={19} /><strong>没有匹配的 Connector</strong><span>调整关键词或筛选条件后重试。</span></div> : null}
                  </div>
                </div>
              ) : null}

              {editor.provider ? (
                <div className="connector-editor-form">
                  <div className="connector-selected-provider">
                    <span className="connector-result-icon"><ProviderIcon provider={providerSummary(editor.provider)} /></span>
                    <div><strong>{editor.provider.displayName}</strong><small>{editor.provider.service} · {editor.provider.actionCount} 个 Action</small></div>
                    {editor.mode === "create" ? <button type="button" onClick={() => patchEditor({ provider: undefined, authType: undefined, values: {}, oauthConfig: undefined })}>更换</button> : <span>Connector 固定</span>}
                  </div>

                  <div className="gateway-channel-fields connector-fields">
                    <label className="field-label"><span>连接名称</span><input value={editor.connectionName} disabled={editor.mode === "edit"} onChange={(event) => patchEditor({ connectionName: event.target.value })} placeholder="default" /></label>
                    <label className="field-label"><span>连接方式</span><select value={editor.authType || ""} onChange={(event) => changeAuthType(event.target.value as ConnectorAuthType)}>{editor.provider.auth.map((auth) => <option value={auth.type} key={auth.type}>{connectorAuthLabels[auth.type]}</option>)}</select></label>
                    {selectedFields.map((field) => (
                      <DynamicField key={field.key} field={field} value={editor.values[field.key] || ""} onChange={(value) => patchEditor({ values: { ...editor.values, [field.key]: value } })} />
                    ))}
                  </div>

                  {selectedAuth?.type === "no_auth" ? <div className="connector-auth-note"><ShieldCheck size={16} /><div><strong>无需认证</strong><p>该 Connector 由 OpenConnector 作为系统可用连接提供，不会保存凭据。</p></div></div> : null}

                  {selectedAuth?.type === "oauth2" ? (
                    <div className="connector-oauth-panel">
                      <div className="connector-oauth-heading"><div><span className="card-kicker">OAuth应用</span><strong>{editor.oauthConfig?.configured && !editor.reconfigureOAuth ? "服务端已配置" : "配置应用并授权"}</strong></div>{editor.oauthConfig?.configured && !editor.reconfigureOAuth ? <button type="button" onClick={() => patchEditor({ reconfigureOAuth: true, oauthClientSecret: "" })}>重新配置应用</button> : null}</div>
                      {editor.oauthConfig ? <label className="field-label connector-callback-field"><span>回调地址</span><span className="connector-copy-row"><input readOnly value={editor.oauthConfig.expectedRedirectUri} /><button type="button" onClick={() => navigator.clipboard.writeText(editor.oauthConfig?.expectedRedirectUri || "")}>复制</button></span></label> : null}
                      {editor.oauthConfig?.configured && !editor.reconfigureOAuth ? <div className="connector-auth-note"><CheckCircle2 size={16} /><div><strong>OAuth Client 已配置</strong><p>Client ID：{editor.oauthConfig.clientId || "已保存"}。可以直接发起账号授权。</p></div></div> : (
                        <div className="gateway-channel-fields connector-fields connector-oauth-fields">
                          <label className="field-label"><span>Client ID</span><input value={editor.oauthClientId} onChange={(event) => patchEditor({ oauthClientId: event.target.value })} /></label>
                          <label className="field-label"><span>Client Secret</span><input type="password" autoComplete="new-password" value={editor.oauthClientSecret} onChange={(event) => patchEditor({ oauthClientSecret: event.target.value })} /></label>
                          {oauthFields.map((field) => <DynamicField key={field.key} field={field} value={editor.oauthValues[field.key] || ""} onChange={(value) => patchEditor({ oauthValues: { ...editor.oauthValues, [field.key]: value } })} />)}
                        </div>
                      )}
                      {selectedAuth.scopes.length ? <div className="connector-scope-list"><span>将申请权限</span><div>{selectedAuth.scopes.slice(0, 8).map((scope) => <code key={scope}>{scope}</code>)}{selectedAuth.scopes.length > 8 ? <code>+{selectedAuth.scopes.length - 8}</code> : null}</div></div> : null}
                    </div>
                  ) : null}

                  {selectedAuth && selectedAuth.type !== "no_auth" ? <div className="gateway-channel-drawer__secret"><div className="gateway-key-state"><KeyRound size={14} />凭据仅提交到 AI Console 服务端并由 OpenConnector 加密保存，不会在浏览器回显。</div></div> : null}
                </div>
              ) : null}
            </div>

            <div className="gateway-channel-editor__footer">
              {editor.authType === "oauth2" && state === "loading" ? <span className="connector-oauth-wait"><ExternalLink size={14} />等待授权窗口完成</span> : null}
              <button className="button button--secondary" type="button" onClick={closeEditor} disabled={state === "saving"}>取消</button>
              <button className="button button--primary" type="button" onClick={saveEditor} disabled={!editor.provider || !editor.authType || state === "saving" || state === "loading"}>
                {state === "saving" ? <RefreshCw className="is-spinning" size={14} /> : editor.authType === "oauth2" ? <ExternalLink size={14} /> : <Save size={14} />}
                {state === "saving" ? "处理中" : editor.authType === "oauth2" ? "保存并授权" : editor.mode === "create" ? "添加连接" : "保存连接"}
              </button>
            </div>
          </aside>
        </div>,
        document.body,
      ) : null}
    </>
  );
}

function DynamicField({ field, value, onChange }: {
  field: ConnectorCredentialField | ConnectorOAuthClientField;
  value: string;
  onChange: (value: string) => void;
}) {
  const id = `connector-field-${field.key.replace(/[^a-zA-Z0-9_-]/g, "-")}`;
  const textarea = field.inputType === "textarea" || field.inputType === "json";
  return (
    <label className={`field-label${textarea ? " connector-field--wide" : ""}`} htmlFor={id}>
      <span>{field.label}{field.required ? " *" : ""}</span>
      {textarea ? <textarea id={id} rows={field.inputType === "json" ? 6 : 4} className={field.inputType === "json" ? "mono-input" : undefined} value={value} onChange={(event) => onChange(event.target.value)} placeholder={field.placeholder} /> : <input id={id} type={field.secret || field.inputType === "password" ? "password" : "text"} autoComplete={field.secret ? "new-password" : undefined} value={value} onChange={(event) => onChange(event.target.value)} placeholder={field.placeholder} />}
      {field.description ? <small className="connector-field-help">{field.description}</small> : null}
    </label>
  );
}
