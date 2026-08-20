"use client";

import {
  AlertCircle,
  Bot,
  Building2,
  ChevronDown,
  CheckCircle2,
  ExternalLink,
  Link2,
  LoaderCircle,
  LockKeyhole,
  MessageSquareShare,
  Pencil,
  QrCode,
  ShieldCheck,
  Unlink,
  UserRound,
  X,
} from "lucide-react";
import { useCallback, useEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";

import type {
  EmployeeAvailableConnection,
  EmployeeConnectorBinding,
  EmployeeIntegrationApplication,
  EmployeeIntegrationsSnapshot,
  EmployeeWeComOrganization,
  EnterpriseIntegrationPlatform,
} from "@/lib/control-plane/integrations";

type RequestState = {
  applicationId: string;
  action: "authorizing" | "disconnecting";
};

type PersonalConnectionRequestState = {
  connectionName: string;
  action: "disconnecting" | "renaming";
};

type PersonalConnectionEditState = {
  connectionName: string;
  displayName: string;
};

type WeComBotAuthorizationState =
  | { status: "starting" }
  | { status: "waiting"; request: string; pageUrl: string; expiresAt: string }
  | { status: "error"; message: string };

const wecomLinkResultMessages: Partial<Record<string, { tone: "success" | "error"; text: string }>> = {
  linked: { tone: "success", text: "企业微信身份已与当前平台账号绑定。" },
  expired: { tone: "error", text: "企业微信身份绑定请求已过期，请重新发起。" },
  conflict: { tone: "error", text: "该企业微信身份已绑定到另一个平台账号。" },
  invalid: { tone: "error", text: "未获得本次绑定所需的可信企业微信身份，请重新打开企业微信应用。" },
  denied: { tone: "error", text: "企业微信认证已取消，当前平台账号未发生变化。" },
  failed: { tone: "error", text: "企业微信身份绑定失败，请稍后重试或联系管理员。" },
};

export function wecomLinkResultMessage(result?: string) {
  return result ? wecomLinkResultMessages[result] : undefined;
}

const platformIcons: Partial<Record<EnterpriseIntegrationPlatform, typeof MessageSquareShare>> = {
  feishu: MessageSquareShare,
  wecom: Building2,
  dingtalk: ShieldCheck,
};

const pollingIntervalMs = 1_500;
const maxPollingAttempts = 200;

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

function bindingPresentation(binding?: EmployeeConnectorBinding) {
  switch (binding?.status) {
    case "connected":
      return { label: "已绑定", className: "is-connected", Icon: CheckCircle2 };
    case "pending":
      return { label: "等待授权", className: "is-pending", Icon: LoaderCircle };
    case "error":
      return { label: "绑定异常", className: "is-error", Icon: AlertCircle };
    default:
      return { label: "未绑定", className: "is-idle", Icon: Link2 };
  }
}

function formatConnectedAt(value?: string | null) {
  if (!value) return "";
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return "";
  return new Intl.DateTimeFormat("zh-CN", {
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    hour12: false,
  }).format(date);
}

const wecomIntegrationPrefix = "wecom:";

export function wecomOrganizationIntegrationId(organizationId: string) {
  return `${wecomIntegrationPrefix}${organizationId}`;
}

function wecomOrganizationForIntegration(
  snapshot: EmployeeIntegrationsSnapshot,
  integrationId: string,
) {
  if (!integrationId.startsWith(wecomIntegrationPrefix)) return undefined;
  const organizationId = integrationId.slice(wecomIntegrationPrefix.length);
  return snapshot.wecomOrganizations.find((organization) => organization.id === organizationId);
}

export function wecomOrganizationBindingPresentation(
  organization: Pick<EmployeeWeComOrganization, "active" | "configured">,
  linked: boolean,
) {
  if (!organization.active) {
    return { label: "已停用", className: "is-error", Icon: AlertCircle };
  }
  if (!organization.configured) {
    return { label: "不可用", className: "is-error", Icon: AlertCircle };
  }
  return linked
    ? { label: "已绑定", className: "is-connected", Icon: CheckCircle2 }
    : { label: "未绑定", className: "is-idle", Icon: Link2 };
}

export function AccountIntegrationManager({ wecomLinkResult }: { wecomLinkResult?: string }) {
  const [snapshot, setSnapshot] = useState<EmployeeIntegrationsSnapshot>();
  const [loading, setLoading] = useState(true);
  const [requestState, setRequestState] = useState<RequestState>();
  const [personalConnectionRequestState, setPersonalConnectionRequestState] = useState<PersonalConnectionRequestState>();
  const [personalConnectionEditState, setPersonalConnectionEditState] = useState<PersonalConnectionEditState>();
  const [wecomBusy, setWecomBusy] = useState(false);
  const [wecomBotAuthorization, setWecomBotAuthorization] = useState<WeComBotAuthorizationState>();
  const [selectedIntegrationId, setSelectedIntegrationId] = useState<string>();
  const [message, setMessage] = useState<{ tone: "info" | "success" | "error"; text: string } | undefined>(
    () => wecomLinkResultMessage(wecomLinkResult),
  );
  const pollingTimerRef = useRef<ReturnType<typeof setInterval> | undefined>(undefined);
  const wecomBotPollingTimerRef = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);
  const wecomBotAuthorizationGenerationRef = useRef(0);
  const popupRef = useRef<Window | null>(null);
  const mountedRef = useRef(true);
  const drawerRef = useRef<HTMLElement>(null);
  const wecomBotDialogRef = useRef<HTMLElement>(null);
  const selectedWeComOrganization = snapshot && selectedIntegrationId
    ? wecomOrganizationForIntegration(snapshot, selectedIntegrationId)
    : undefined;
  const selectedWeComIdentity = selectedWeComOrganization
    ? snapshot?.wecomIdentity.identities.find((identity) => (
        identity.organizationId === selectedWeComOrganization.id
      ))
    : undefined;
  const selectedApplication = selectedIntegrationId && !selectedWeComOrganization
    ? snapshot?.applications.find((application) => application.id === selectedIntegrationId)
    : undefined;
  const selectedConnections = snapshot && selectedIntegrationId
    ? connectionsForIntegration(snapshot, selectedIntegrationId)
    : [];
  const selectedIntegration = selectedWeComOrganization
    ? {
        title: selectedWeComOrganization.organizationName,
        platform: "企业微信",
        status: wecomOrganizationBindingPresentation(
          selectedWeComOrganization,
          Boolean(selectedWeComIdentity),
        ).label,
        emptyMessage: selectedWeComIdentity
          ? "当前组织身份没有可用连接。"
          : `从“${selectedWeComOrganization.organizationName}”的企业微信应用首页完成身份认证后，可见范围内的共享连接会显示在这里。`,
      }
    : selectedApplication
      ? {
          title: selectedApplication.name,
          platform: selectedApplication.platformDisplayName,
          status: bindingPresentation(selectedApplication.binding).label,
          emptyMessage: selectedApplication.binding?.status === "connected"
            ? "当前个人授权尚未提供可用的 Action。"
            : "完成该应用的个人账号绑定后，可用连接和权限会显示在这里。",
        }
      : undefined;
  const integrationDrawerOpen = Boolean(selectedIntegration);
  const wecomBotDialogOpen = Boolean(wecomBotAuthorization);
  const wecomBotDialogOpenRef = useRef(wecomBotDialogOpen);

  const stopPolling = useCallback(() => {
    if (pollingTimerRef.current) clearInterval(pollingTimerRef.current);
    pollingTimerRef.current = undefined;
  }, []);

  const stopWeComBotPolling = useCallback(() => {
    if (wecomBotPollingTimerRef.current) clearTimeout(wecomBotPollingTimerRef.current);
    wecomBotPollingTimerRef.current = undefined;
  }, []);

  const closeWeComBotAuthorization = useCallback(() => {
    wecomBotAuthorizationGenerationRef.current += 1;
    stopWeComBotPolling();
    setWecomBotAuthorization(undefined);
  }, [stopWeComBotPolling]);

  const closeIntegrationDetails = useCallback(() => {
    closeWeComBotAuthorization();
    setPersonalConnectionEditState(undefined);
    setSelectedIntegrationId(undefined);
  }, [closeWeComBotAuthorization]);

  const reload = useCallback(async () => {
    const next = await fetchJson<EmployeeIntegrationsSnapshot>("/api/account/integrations");
    if (mountedRef.current) setSnapshot(next);
    return next;
  }, []);

  useEffect(() => {
    mountedRef.current = true;
    reload()
      .catch((error) => {
        if (!mountedRef.current) return;
        setMessage({
          tone: "error",
          text: error instanceof Error ? error.message : "账号集成信息读取失败",
        });
      })
      .finally(() => {
        if (mountedRef.current) setLoading(false);
      });

    return () => {
      mountedRef.current = false;
      stopPolling();
      stopWeComBotPolling();
    };
  }, [reload, stopPolling, stopWeComBotPolling]);

  useEffect(() => {
    if (!wecomLinkResult) return;
    const query = new URLSearchParams(window.location.search);
    query.delete("wecom_link");
    const suffix = query.toString();
    window.history.replaceState(null, "", `${window.location.pathname}${suffix ? `?${suffix}` : ""}`);
  }, [wecomLinkResult]);

  useEffect(() => {
    wecomBotDialogOpenRef.current = wecomBotDialogOpen;
  }, [wecomBotDialogOpen]);

  useEffect(() => {
    if (!integrationDrawerOpen) return;
    const previouslyFocused = document.activeElement instanceof HTMLElement ? document.activeElement : undefined;
    const previousOverflow = document.body.style.overflow;
    document.body.style.overflow = "hidden";
    const frame = requestAnimationFrame(() => {
      drawerRef.current?.querySelector<HTMLElement>("[data-drawer-autofocus]")?.focus();
    });

    function handleKeyDown(event: KeyboardEvent) {
      if (wecomBotDialogOpenRef.current) return;
      if (event.key === "Escape") {
        closeIntegrationDetails();
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
  }, [closeIntegrationDetails, integrationDrawerOpen, selectedIntegrationId]);

  useEffect(() => {
    if (!wecomBotDialogOpen) return;
    const previouslyFocused = document.activeElement instanceof HTMLElement ? document.activeElement : undefined;
    const frame = requestAnimationFrame(() => {
      wecomBotDialogRef.current?.querySelector<HTMLElement>("[data-modal-autofocus]")?.focus();
    });

    function handleKeyDown(event: KeyboardEvent) {
      if (event.key === "Escape") {
        event.preventDefault();
        closeWeComBotAuthorization();
        return;
      }
      if (event.key !== "Tab" || !wecomBotDialogRef.current) return;
      const focusable = Array.from(wecomBotDialogRef.current.querySelectorAll<HTMLElement>(
        "button:not([disabled]), input:not([disabled]), select:not([disabled]), textarea:not([disabled]), iframe, [href]",
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
      previouslyFocused?.focus();
    };
  }, [closeWeComBotAuthorization, wecomBotDialogOpen]);

  async function disconnectWeComIdentity(linkId: string, organizationName: string) {
    if (!window.confirm(`确认解绑“${organizationName}”中的企业微信身份？`)) return;
    setWecomBusy(true);
    setMessage({ tone: "info", text: "正在解绑企业微信身份…" });
    try {
      await fetchJson<unknown>(`/api/account/wecom-identity?id=${encodeURIComponent(linkId)}`, { method: "DELETE" });
      await reload();
      setMessage({ tone: "success", text: "企业微信身份已解绑。" });
    } catch (error) {
      setMessage({
        tone: "error",
        text: error instanceof Error ? error.message : "企业微信身份解绑失败",
      });
    } finally {
      setWecomBusy(false);
    }
  }

  const pollWeComBotAuthorization = useCallback((request: string, generation: number) => {
    stopWeComBotPolling();
    const poll = async () => {
      try {
        const result = await fetchJson<{ status: "pending" | "connected"; connectionName?: string }>(
          `/api/account/wecom-bots/authorize?request=${encodeURIComponent(request)}`,
        );
        if (!mountedRef.current || wecomBotAuthorizationGenerationRef.current !== generation) return;
        if (result.status === "connected") {
          closeWeComBotAuthorization();
          setMessage({ tone: "success", text: "企业微信机器人已创建并绑定为个人连接。" });
          try {
            await reload();
          } catch (error) {
            if (mountedRef.current) {
              setMessage({
                tone: "error",
                text: error instanceof Error ? `机器人已创建，但连接列表刷新失败：${error.message}` : "机器人已创建，但连接列表刷新失败。",
              });
            }
          }
          return;
        }
        if (mountedRef.current && wecomBotAuthorizationGenerationRef.current === generation) {
          wecomBotPollingTimerRef.current = setTimeout(poll, 3_000);
        }
      } catch (error) {
        stopWeComBotPolling();
        if (!mountedRef.current || wecomBotAuthorizationGenerationRef.current !== generation) return;
        const text = error instanceof Error ? error.message : "企业微信机器人扫码绑定失败";
        setWecomBotAuthorization({ status: "error", message: text });
      }
    };
    wecomBotPollingTimerRef.current = setTimeout(poll, 1_000);
  }, [closeWeComBotAuthorization, reload, stopWeComBotPolling]);

  async function startWeComBotAuthorization() {
    if (
      !selectedWeComOrganization?.active
      || !selectedWeComOrganization.configured
      || !selectedWeComIdentity
      || wecomBotAuthorization?.status === "starting"
    ) return;
    stopWeComBotPolling();
    const generation = wecomBotAuthorizationGenerationRef.current + 1;
    wecomBotAuthorizationGenerationRef.current = generation;
    setWecomBotAuthorization({ status: "starting" });
    setMessage(undefined);
    try {
      const session = await fetchJson<{ request: string; pageUrl: string; expiresAt: string }>(
        "/api/account/wecom-bots/authorize",
        { method: "POST" },
      );
      if (!mountedRef.current || wecomBotAuthorizationGenerationRef.current !== generation) return;
      setWecomBotAuthorization({ status: "waiting", ...session });
      pollWeComBotAuthorization(session.request, generation);
    } catch (error) {
      if (!mountedRef.current || wecomBotAuthorizationGenerationRef.current !== generation) return;
      const text = error instanceof Error ? error.message : "企业微信机器人二维码生成失败";
      setWecomBotAuthorization({ status: "error", message: text });
    }
  }

  const pollBinding = useCallback((applicationId: string, popup: Window) => {
    stopPolling();
    let attempt = 0;
    let closedAttempts = 0;
    let checking = false;
    pollingTimerRef.current = setInterval(async () => {
      if (checking) return;
      checking = true;
      attempt += 1;
      try {
        const next = await reload();
        const application = next.applications.find((item) => item.id === applicationId);
        if (application?.binding?.status === "connected") {
          stopPolling();
          try {
            if (!popup.closed) popup.close();
          } catch {
            // The OAuth window can become cross-origin while authorization is active.
          }
          if (mountedRef.current) {
            setRequestState(undefined);
            setMessage({ tone: "success", text: `${application.name}账号已绑定，可在支持 AI Base MCP 的客户端中按当前身份使用。` });
          }
          return;
        }

        if (application?.binding?.status === "error") {
          stopPolling();
          if (mountedRef.current) {
            setRequestState(undefined);
            setMessage({
              tone: "error",
              text: application.binding.errorMessage || `${application.name}账号授权失败，请重新绑定。`,
            });
          }
          return;
        }

        let popupClosed = false;
        try {
          popupClosed = popup.closed;
        } catch {
          popupClosed = false;
        }
        closedAttempts = popupClosed ? closedAttempts + 1 : 0;
        if (attempt >= maxPollingAttempts || closedAttempts >= 2) {
          stopPolling();
          if (mountedRef.current) {
            setRequestState(undefined);
            setMessage({
              tone: "info",
              text: popupClosed ? "授权窗口已关闭；如已完成授权，请稍后刷新页面确认。" : "授权等待超时，请重新发起绑定。",
            });
          }
          return;
        }
      } catch (error) {
        if (attempt >= maxPollingAttempts) {
          stopPolling();
          if (mountedRef.current) {
            setRequestState(undefined);
            setMessage({
              tone: "error",
              text: error instanceof Error ? error.message : "检查账号绑定状态失败",
            });
          }
          return;
        }
      } finally {
        checking = false;
      }
    }, pollingIntervalMs);
  }, [reload, stopPolling]);

  async function authorize(application: EmployeeIntegrationApplication) {
    if (application.bindingMode === "unsupported" || !application.active) return;
    stopPolling();

    try {
      if (popupRef.current && !popupRef.current.closed) popupRef.current.close();
    } catch {
      // Ignore stale cross-origin popup references.
    }

    const popup = window.open(
      "",
      `ai-base-${application.id}-authorization`,
      "popup=yes,width=560,height=720,resizable=yes,scrollbars=yes",
    );
    if (!popup) {
      setMessage({ tone: "error", text: "浏览器拦截了授权窗口，请允许本站打开弹窗后重试。" });
      return;
    }

    popupRef.current = popup;
    try {
      popup.document.title = "正在准备账号授权";
      popup.document.body.style.cssText = "margin:0;display:grid;min-height:100vh;place-items:center;background:#1c1c1e;color:#f5f5f7;font:16px -apple-system,BlinkMacSystemFont,'PingFang SC',sans-serif";
      popup.document.body.textContent = "正在准备账号授权…";
    } catch {
      // The blank popup is best-effort presentation only.
    }

    setRequestState({ applicationId: application.id, action: "authorizing" });
    setMessage({ tone: "info", text: `正在准备${application.name}账号授权…` });
    try {
      const result = await fetchJson<{ authorizationUrl: string }>(
        `/api/account/integrations/${encodeURIComponent(application.id)}/authorize`,
        { method: "POST" },
      );
      if (!result.authorizationUrl) throw new Error("授权服务未返回有效地址");
      popup.location.replace(result.authorizationUrl);
      popup.focus();
      setMessage({ tone: "info", text: `请在新窗口完成${application.name}账号授权，本页会自动更新绑定状态。` });
      pollBinding(application.id, popup);
    } catch (error) {
      popup.close();
      popupRef.current = null;
      setRequestState(undefined);
      setMessage({
        tone: "error",
        text: error instanceof Error ? error.message : `${application.name}账号授权启动失败`,
      });
    }
  }

  async function disconnect(application: EmployeeIntegrationApplication) {
    if (!window.confirm(`确认解绑 ${application.name} 下的当前账号？解绑后，已接入 AI Base MCP 的客户端将无法再通过此身份调用对应连接器。`)) return;
    stopPolling();
    setRequestState({ applicationId: application.id, action: "disconnecting" });
    setMessage({ tone: "info", text: `正在解绑${application.name}账号…` });
    try {
      await fetchJson<unknown>(
        `/api/account/integrations/${encodeURIComponent(application.id)}/authorize`,
        { method: "DELETE" },
      );
      await reload();
      setMessage({ tone: "success", text: `${application.name}账号已解绑。` });
    } catch (error) {
      setMessage({
        tone: "error",
        text: error instanceof Error ? error.message : `${application.name}账号解绑失败`,
      });
    } finally {
      setRequestState(undefined);
    }
  }

  async function disconnectPersonalWeComBot(connection: EmployeeAvailableConnection) {
    if (!isDisconnectablePersonalWeComBot(connection)) return;
    if (!window.confirm(`确认解绑个人机器人“${connection.displayName}”？解绑后，该机器人连接和凭据将从 AI Base 中移除。`)) return;
    setPersonalConnectionRequestState({ connectionName: connection.connectionName, action: "disconnecting" });
    setMessage({ tone: "info", text: `正在解绑${connection.displayName}…` });
    try {
      await fetchJson<unknown>(
        `/api/account/wecom-bots/${encodeURIComponent(connection.connectionName)}`,
        { method: "DELETE" },
      );
      await reload();
      setPersonalConnectionEditState(undefined);
      setMessage({ tone: "success", text: `${connection.displayName}已解绑。` });
    } catch (error) {
      setMessage({
        tone: "error",
        text: error instanceof Error ? error.message : `${connection.displayName}解绑失败`,
      });
    } finally {
      setPersonalConnectionRequestState(undefined);
    }
  }

  async function renamePersonalWeComBot(connection: EmployeeAvailableConnection) {
    if (!isDisconnectablePersonalWeComBot(connection)) return;
    const displayName = personalConnectionEditState?.displayName.trim() || "";
    if (!displayName) {
      setMessage({ tone: "error", text: "请输入连接名称。" });
      return;
    }
    if (displayName === connection.displayName) {
      setPersonalConnectionEditState(undefined);
      return;
    }
    setPersonalConnectionRequestState({ connectionName: connection.connectionName, action: "renaming" });
    try {
      await fetchJson<{ renamed: true; displayName: string }>(
        `/api/account/wecom-bots/${encodeURIComponent(connection.connectionName)}`,
        {
          method: "PATCH",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ displayName }),
        },
      );
      await reload();
      setPersonalConnectionEditState(undefined);
      setMessage({ tone: "success", text: `连接名称已更新为“${displayName}”。` });
    } catch (error) {
      setMessage({
        tone: "error",
        text: error instanceof Error ? error.message : "企业微信机器人连接重命名失败",
      });
    } finally {
      setPersonalConnectionRequestState(undefined);
    }
  }

  if (loading) {
    return (
      <div className="account-integration-loading" aria-live="polite">
        <LoaderCircle className="is-spinning" size={20} />
        <span>正在读取账号与企业集成…</span>
      </div>
    );
  }

  return (
    <>
      {message ? (
        <div className={`account-integration-message is-${message.tone}`} role={message.tone === "error" ? "alert" : "status"}>
          {message.tone === "success" ? <CheckCircle2 size={16} /> : message.tone === "error" ? <AlertCircle size={16} /> : <LoaderCircle className={requestState?.action === "authorizing" ? "is-spinning" : ""} size={16} />}
          <span>{message.text}</span>
          <button type="button" onClick={() => setMessage(undefined)} aria-label="关闭提示">关闭</button>
        </div>
      ) : null}

      <section className="account-identity-strip" aria-label="当前账号">
        <span><UserRound size={20} /></span>
        <div>
          <strong>{snapshot?.identity.name || snapshot?.identity.email || "当前员工"}</strong>
          {snapshot?.identity.email && snapshot.identity.email !== snapshot.identity.name ? <small>{snapshot.identity.email}</small> : null}
        </div>
        <p><LockKeyhole size={14} />个人 OAuth 授权只对当前登录身份生效</p>
      </section>

      <div className="account-integration-grid">
        {snapshot?.wecomOrganizations.length ? snapshot.wecomOrganizations.map((organization) => {
          const identityLink = snapshot.wecomIdentity.identities.find((identity) => (
            identity.organizationId === organization.id
          ));
          const integrationId = wecomOrganizationIntegrationId(organization.id);
          return (
            <WeComIdentityCard
              organization={organization}
              identityLink={identityLink}
              availableConnectionCount={connectionsForIntegration(snapshot, integrationId).length}
              onOpen={() => setSelectedIntegrationId(integrationId)}
              key={organization.id}
            />
          );
        }) : (
          <WeComIdentityCard availableConnectionCount={0} />
        )}
        {(snapshot?.applications || []).map((application) => (
          <AccountIntegrationCard
            application={application}
            busy={requestState?.applicationId === application.id}
            action={requestState?.applicationId === application.id ? requestState.action : undefined}
            onOpen={() => setSelectedIntegrationId(application.id)}
            onAuthorize={() => authorize(application)}
            onDisconnect={() => disconnect(application)}
            key={application.id}
          />
        ))}
      </div>

      {selectedIntegration ? createPortal(
        <div className="gateway-channel-drawer-backdrop" onMouseDown={(event) => { if (event.target === event.currentTarget) closeIntegrationDetails(); }}>
          <aside
            className="gateway-channel-drawer account-connection-drawer"
            ref={drawerRef}
            role="dialog"
            aria-modal="true"
            aria-hidden={wecomBotDialogOpen || undefined}
            inert={wecomBotDialogOpen || undefined}
            aria-labelledby="account-connection-details-title"
          >
            <div className="gateway-channel-editor__header">
              <div>
                <span className="card-kicker">集成权限</span>
                <h3 id="account-connection-details-title">{selectedIntegration.title}</h3>
                <p>{selectedWeComOrganization && selectedWeComIdentity
                  ? "查看当前组织绑定关系及该身份可用的连接和 Actions。"
                  : "只读展示此集成向当前身份提供的连接和 Actions。"}</p>
              </div>
              <button type="button" data-drawer-autofocus onClick={closeIntegrationDetails} aria-label="关闭集成权限"><X size={17} /></button>
            </div>

            <div className="gateway-channel-drawer__body resource-detail-body">
              <section className="resource-detail-section">
                <div className="resource-detail-section__header">
                  <strong>集成信息</strong>
                  <span className={`gateway-channel-state${selectedIntegration.status === "已绑定" ? " is-enabled" : ""}`}>{selectedIntegration.status}</span>
                </div>
                <dl className="resource-detail-grid">
                  <div><dt>平台</dt><dd>{selectedIntegration.platform}</dd></div>
                  <div><dt>可用连接</dt><dd>{selectedConnections.length} 个</dd></div>
                </dl>
              </section>

              {selectedWeComOrganization ? (
                <section className="resource-detail-section">
                  <div className="resource-detail-section__header"><strong>账号绑定</strong><span>当前组织</span></div>
                  <div className="account-wecom-identity-list">
                    <div className="account-wecom-identity-row">
                      <span className="account-integration-card__icon integration-icon--wecom"><Building2 size={17} /></span>
                      <div>
                        <strong>{selectedWeComOrganization.organizationName}</strong>
                        <small>{selectedWeComIdentity
                          ? `绑定于 ${formatConnectedAt(selectedWeComIdentity.linkedAt)}`
                          : selectedWeComOrganization.active && selectedWeComOrganization.configured
                            ? "尚未绑定当前平台账号"
                            : selectedWeComOrganization.active
                              ? "认证配置尚不可用"
                              : "组织已停用"}</small>
                      </div>
                      {selectedWeComIdentity ? (
                        <button className="button button--secondary" type="button" disabled={wecomBusy} onClick={() => void disconnectWeComIdentity(selectedWeComIdentity.id, selectedWeComOrganization.organizationName)}>
                          {wecomBusy ? <LoaderCircle className="is-spinning" size={14} /> : <Unlink size={14} />}解绑
                        </button>
                      ) : null}
                    </div>
                  </div>
                </section>
              ) : null}

              {selectedConnections.length ? selectedConnections.map((connection, index) => {
                const presentation = connectionDetailPresentation(
                  connection,
                  index,
                  selectedConnections.length,
                  selectedIntegrationId,
                );
                const multipleWeComBots = Boolean(selectedWeComOrganization) && selectedConnections.length > 1;
                const ConnectionIcon = selectedWeComOrganization
                  ? Bot
                  : selectedApplication
                    ? platformIcons[selectedApplication.platform] || Link2
                    : Link2;
                return (
                  <section
                    className={`resource-detail-section account-connection-detail${multipleWeComBots ? " is-multiple" : ""}`}
                    aria-label={`${presentation.eyebrow} ${presentation.title}，连接名称 ${connection.connectionName}`}
                    key={connection.id}
                  >
                    <div className="resource-detail-section__header account-connection-detail__header">
                      <div className="account-connection-detail__identity">
                        <span><ConnectionIcon size={17} /></span>
                        <div>
                          <small>{presentation.eyebrow}</small>
                          <strong>{presentation.title}</strong>
                        </div>
                      </div>
                      <div className="account-connection-detail__controls">
                        <span className={`gateway-channel-state${connection.accessMode === "account_bound" ? " is-enabled" : " is-managed"}`}>
                          {connectionAccessLabel(connection)}
                        </span>
                        {isDisconnectablePersonalWeComBot(connection) ? (
                          <>
                            <button
                              className="button button--secondary account-connection-detail__rename"
                              type="button"
                              onClick={() => setPersonalConnectionEditState({
                                connectionName: connection.connectionName,
                                displayName: connection.displayName,
                              })}
                              disabled={personalConnectionRequestState?.connectionName === connection.connectionName}
                            >
                              <Pencil size={14} />
                              改名
                            </button>
                            <button
                              className="button button--secondary account-connection-detail__disconnect"
                              type="button"
                              onClick={() => disconnectPersonalWeComBot(connection)}
                              disabled={personalConnectionRequestState?.connectionName === connection.connectionName}
                            >
                              {personalConnectionRequestState?.connectionName === connection.connectionName
                                && personalConnectionRequestState.action === "disconnecting"
                                ? <LoaderCircle className="is-spinning" size={14} />
                                : <Unlink size={14} />}
                              {personalConnectionRequestState?.connectionName === connection.connectionName
                                && personalConnectionRequestState.action === "disconnecting" ? "解绑中" : "解绑"}
                            </button>
                          </>
                        ) : null}
                      </div>
                    </div>
                    {personalConnectionEditState?.connectionName === connection.connectionName ? (
                      <form
                        className="account-connection-rename"
                        onSubmit={(event) => {
                          event.preventDefault();
                          void renamePersonalWeComBot(connection);
                        }}
                      >
                        <label htmlFor={`connection-display-name-${connection.id}`}>显示名称</label>
                        <div>
                          <input
                            id={`connection-display-name-${connection.id}`}
                            autoFocus
                            maxLength={120}
                            required
                            value={personalConnectionEditState.displayName}
                            onChange={(event) => setPersonalConnectionEditState({
                              connectionName: connection.connectionName,
                              displayName: event.target.value,
                            })}
                          />
                          <button
                            className="button button--primary"
                            type="submit"
                            disabled={personalConnectionRequestState?.connectionName === connection.connectionName}
                          >
                            {personalConnectionRequestState?.connectionName === connection.connectionName
                              && personalConnectionRequestState.action === "renaming"
                              ? <LoaderCircle className="is-spinning" size={14} />
                              : null}
                            {personalConnectionRequestState?.connectionName === connection.connectionName
                              && personalConnectionRequestState.action === "renaming" ? "保存中" : "保存"}
                          </button>
                          <button
                            className="button button--secondary"
                            type="button"
                            onClick={() => setPersonalConnectionEditState(undefined)}
                            disabled={personalConnectionRequestState?.connectionName === connection.connectionName}
                          >
                            取消
                          </button>
                        </div>
                      </form>
                    ) : null}
                    <dl className="resource-detail-grid">
                      <div><dt>连接名称</dt><dd className="is-mono">{connection.connectionName}</dd></div>
                      <div><dt>可用权限</dt><dd>{connection.actions.length} 个 Action</dd></div>
                    </dl>
                    <AccountConnectionActionList
                      connection={connection}
                      collapsible={Boolean(selectedWeComOrganization)}
                    />
                  </section>
                );
              }) : (
                <div className="gateway-mcp-tools-state account-integration-empty">
                  <Link2 size={20} />
                  <strong>当前集成没有可用连接</strong>
                  <p>{selectedIntegration.emptyMessage}</p>
                </div>
              )}
            </div>

            <div className="gateway-channel-editor__footer account-connection-drawer__footer">
              {selectedWeComOrganization?.active && selectedWeComOrganization.configured && selectedWeComIdentity ? (
                <button className="button button--secondary" type="button" onClick={startWeComBotAuthorization}>
                  <QrCode size={15} />
                  创建机器人
                </button>
              ) : null}
              <button className="button button--secondary account-connection-drawer__close" type="button" onClick={closeIntegrationDetails}>关闭</button>
            </div>
          </aside>
        </div>,
        document.body,
      ) : null}

      {selectedWeComOrganization && wecomBotAuthorization ? createPortal(
        <div
          className="account-wecom-qr-modal-backdrop"
          onMouseDown={(event) => { if (event.target === event.currentTarget) closeWeComBotAuthorization(); }}
        >
          <section
            className="account-wecom-qr-modal"
            ref={wecomBotDialogRef}
            role="dialog"
            aria-modal="true"
            aria-labelledby="account-wecom-qr-modal-title"
          >
            <div className="account-wecom-qr-modal__header">
              <div>
                <span className="card-kicker">企业微信</span>
                <h3 id="account-wecom-qr-modal-title">创建个人机器人</h3>
                <p>使用企业微信扫码完成创建。</p>
              </div>
              <button type="button" data-modal-autofocus onClick={closeWeComBotAuthorization} aria-label="关闭创建机器人弹窗">
                <X size={17} />
              </button>
            </div>

            <div className="account-wecom-qr-modal__body">
              {wecomBotAuthorization.status === "starting" ? (
                <div className="account-wecom-qr-modal__state" role="status">
                  <LoaderCircle className="is-spinning" size={22} />
                  <strong>正在生成二维码</strong>
                </div>
              ) : wecomBotAuthorization.status === "waiting" ? (
                <div className="wecom-bot-authorization__qr">
                  <iframe
                    src={wecomBotAuthorization.pageUrl}
                    title="企业微信创建机器人二维码"
                    referrerPolicy="no-referrer"
                    sandbox="allow-scripts allow-same-origin allow-forms allow-popups"
                  />
                  <div>
                    <span><LoaderCircle className="is-spinning" size={15} />等待扫码确认</span>
                    <small>有效期至 {formatConnectedAt(wecomBotAuthorization.expiresAt)}</small>
                    <a href={wecomBotAuthorization.pageUrl} target="_blank" rel="noreferrer">
                      在新窗口打开 <ExternalLink size={13} />
                    </a>
                  </div>
                </div>
              ) : (
                <div className="wecom-bot-authorization__error" role="alert">
                  <AlertCircle size={17} />
                  <span>{wecomBotAuthorization.message}</span>
                </div>
              )}
            </div>

            <div className="account-wecom-qr-modal__footer">
              {wecomBotAuthorization.status === "error" ? (
                <button className="button button--primary" type="button" onClick={startWeComBotAuthorization}>
                  <QrCode size={15} />
                  重新生成
                </button>
              ) : null}
              <button className="button button--secondary" type="button" onClick={closeWeComBotAuthorization}>取消</button>
            </div>
          </section>
        </div>,
        document.body,
      ) : null}
    </>
  );
}

export function connectionAccessLabel(connection: EmployeeAvailableConnection) {
  if (connection.accessMode === "account_bound") return "个人授权";
  return connection.authorizationSources.includes("wecom_visibility") ? "企微可见范围" : "企业共享授权";
}

export function isDisconnectablePersonalWeComBot(connection: EmployeeAvailableConnection) {
  return connection.service === "wecom_bot"
    && connection.accessMode === "account_bound"
    && connection.authorizationSources.includes("personal");
}

export function connectionDetailPresentation(
  connection: EmployeeAvailableConnection,
  index: number,
  total: number,
  integrationId?: string,
) {
  const multipleWeComBots = integrationId?.startsWith(wecomIntegrationPrefix)
    && connection.service === "wecom_bot"
    && total > 1;
  return {
    eyebrow: multipleWeComBots
      ? `企业微信机器人 ${index + 1}/${total}`
      : connection.serviceDisplayName,
    title: connection.displayName,
  };
}

export function AccountConnectionActionList({
  connection,
  collapsible,
}: {
  connection: EmployeeAvailableConnection;
  collapsible: boolean;
}) {
  const actionList = (
    <div className="gateway-mcp-tool-list account-connection-action-list">
      {connection.actions.map((action, actionIndex) => (
        <article key={action.id}>
          <span>{String(actionIndex + 1).padStart(2, "0")}</span>
          <div>
            <strong>{action.name}</strong>
            <code>{action.id}</code>
            <p>{action.description || "此 Action 暂无补充说明。"}</p>
          </div>
        </article>
      ))}
    </div>
  );

  if (!collapsible) return actionList;
  return (
    <details className="account-connection-actions">
      <summary>
        <span>Action 授权</span>
        <span>{connection.actions.length} 个 <ChevronDown size={15} /></span>
      </summary>
      {actionList}
    </details>
  );
}

export function connectionsForIntegration(snapshot: EmployeeIntegrationsSnapshot, integrationId: string) {
  const wecomOrganization = wecomOrganizationForIntegration(snapshot, integrationId);
  if (wecomOrganization) {
    const linked = snapshot.wecomIdentity.identities.some((identity) => (
      identity.organizationId === wecomOrganization.id
    ));
    if (!linked) return [];
    return snapshot.availableConnections.filter((connection) => (
      connection.service === "wecom_bot"
      && (
        !connection.wecomOrganizationIds?.length
        || connection.wecomOrganizationIds.includes(wecomOrganization.id)
      )
    ));
  }
  const binding = snapshot.applications.find((application) => application.id === integrationId)?.binding;
  if (!binding || binding.status !== "connected") return [];
  return snapshot.availableConnections.filter((connection) => (
    connection.service === binding.service && connection.connectionName === binding.connectionName
  ));
}

export function WeComIdentityCard({
  organization,
  identityLink,
  availableConnectionCount,
  onOpen,
}: {
  organization?: EmployeeWeComOrganization;
  identityLink?: EmployeeIntegrationsSnapshot["wecomIdentity"]["identities"][number];
  availableConnectionCount: number;
  onOpen?: () => void;
}) {
  const linked = Boolean(identityLink);
  const binding = organization
    ? wecomOrganizationBindingPresentation(organization, linked)
    : { label: "未配置", className: "is-idle", Icon: Link2 };
  const StatusIcon = binding.Icon;
  const usable = Boolean(organization?.active && organization.configured);
  const organizationName = organization?.organizationName || "企业微信身份";
  return (
    <article className={`account-integration-card${linked && usable ? " is-connected" : ""}`} aria-label={`${organizationName}企业微信身份`}>
      {onOpen ? <button className="account-integration-card__open" type="button" onClick={onOpen} aria-label={`查看${organizationName}的账号绑定与可用权限`} /> : null}
      <header className="account-integration-card__header">
        <span className="account-integration-card__icon integration-icon--wecom"><Building2 size={20} /></span>
        <div>
          <h2>{organizationName}</h2>
          <p>企业微信</p>
        </div>
        <span className={`account-binding-state ${binding.className}`}>
          <StatusIcon size={14} />
          {binding.label}
        </span>
      </header>

      <footer className="account-integration-card__footer">
        <div>
          {!organization ? (
            <>
              <strong>管理员尚未配置企微认证组织</strong>
              <small>配置完成后会按组织显示账号绑定关系</small>
            </>
          ) : linked ? (
            <>
              <strong>企业身份已关联</strong>
              <small>{usable
                ? `${formatConnectedAt(identityLink?.linkedAt)} · ${availableConnectionCount > 0 ? `${availableConnectionCount} 个可用机器人连接` : "暂无可用机器人连接"}`
                : organization.active ? "认证配置尚不可用" : "组织已停用"}</small>
            </>
          ) : !organization.active ? (
            <><strong>管理员已停用此组织</strong><small>已有其他组织绑定不受影响</small></>
          ) : !organization.configured ? (
            <><strong>认证配置尚不可用</strong><small>请联系管理员完成组织配置</small></>
          ) : (
            <>
              <strong>尚未绑定此组织身份</strong>
              <small>请从“{organizationName}”企业微信应用首页进入后认证</small>
            </>
          )}
        </div>

        {organization && usable && !linked ? (
          <button
            className="button button--secondary"
            type="button"
            disabled
            aria-label={`请从${organizationName}企业微信应用首页进入后绑定身份`}
          >
            <Bot size={15} />
            绑定身份
          </button>
        ) : null}
      </footer>
    </article>
  );
}

function AccountIntegrationCard({
  application,
  busy,
  action,
  onOpen,
  onAuthorize,
  onDisconnect,
}: {
  application: EmployeeIntegrationApplication;
  busy: boolean;
  action?: RequestState["action"];
  onOpen: () => void;
  onAuthorize: () => void;
  onDisconnect: () => void;
}) {
  const Icon = platformIcons[application.platform] || Link2;
  const binding = bindingPresentation(application.binding);
  const StatusIcon = binding.Icon;
  const connected = application.binding?.status === "connected";
  const connectedAt = formatConnectedAt(application.binding?.connectedAt);
  const unavailableReason = !application.active
    ? "该应用尚未启用"
    : application.bindingMode === "unsupported"
      ? "当前类型暂不支持账号绑定"
      : undefined;

  return (
    <article className={`account-integration-card${connected ? " is-connected" : ""}`}>
      <button className="account-integration-card__open" type="button" onClick={onOpen} aria-label={`查看${application.name}的可用权限`} />
      <header className="account-integration-card__header">
        <span className={`account-integration-card__icon integration-icon--${application.platform}`}><Icon size={20} /></span>
        <div>
          <h2 title={application.name}>{application.name}</h2>
          <p>{application.platformDisplayName}</p>
        </div>
        <span className={`account-binding-state ${binding.className}`}>
          <StatusIcon className={application.binding?.status === "pending" ? "is-spinning" : ""} size={14} />
          {binding.label}
        </span>
      </header>

      {application.binding?.errorMessage ? (
        <p className="account-binding-error"><AlertCircle size={14} />{application.binding.errorMessage}</p>
      ) : null}

      <footer className="account-integration-card__footer">
        <div>
          {connected ? (
            <>
              <strong>个人连接器已就绪</strong>
              <small>{connectedAt ? `绑定于 ${connectedAt}` : "AI Base 将按当前身份筛选连接器"}</small>
            </>
          ) : unavailableReason ? (
            <>
              <strong>{unavailableReason}</strong>
              <small>{application.active ? "上游支持后即可在此绑定个人身份" : "请联系管理员将此应用设为启用"}</small>
            </>
          ) : (
            <>
              <strong>建立个人连接器</strong>
              <small>授权凭据仅用于当前登录账号</small>
            </>
          )}
        </div>

        {connected ? (
          <button className="button button--secondary account-unbind-button" type="button" onClick={onDisconnect} disabled={busy}>
            {action === "disconnecting" ? <LoaderCircle className="is-spinning" size={15} /> : <Unlink size={15} />}
            {action === "disconnecting" ? "解绑中" : "解绑"}
          </button>
        ) : (
          <button className="button button--primary" type="button" onClick={onAuthorize} disabled={busy || Boolean(unavailableReason)}>
            {action === "authorizing" ? <LoaderCircle className="is-spinning" size={15} /> : <ExternalLink size={15} />}
            {action === "authorizing" ? "绑定中" : "绑定账号"}
          </button>
        )}
      </footer>
    </article>
  );
}
