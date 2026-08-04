"use client";

import {
  AlertCircle,
  Bot,
  Building2,
  CheckCircle2,
  ExternalLink,
  Link2,
  LoaderCircle,
  LockKeyhole,
  MessageSquareShare,
  ShieldCheck,
  Unlink,
  UserRound,
} from "lucide-react";
import { useCallback, useEffect, useRef, useState } from "react";

import type {
  EmployeeConnectorBinding,
  EmployeeIntegrationApplication,
  EmployeeIntegrationsSnapshot,
  EnterpriseIntegrationPlatform,
} from "@/lib/control-plane/integrations";

type RequestState = {
  applicationId: string;
  action: "authorizing" | "disconnecting";
};

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

export function AccountIntegrationManager() {
  const [snapshot, setSnapshot] = useState<EmployeeIntegrationsSnapshot>();
  const [loading, setLoading] = useState(true);
  const [requestState, setRequestState] = useState<RequestState>();
  const [message, setMessage] = useState<{ tone: "info" | "success" | "error"; text: string }>();
  const pollingTimerRef = useRef<ReturnType<typeof setInterval> | undefined>(undefined);
  const popupRef = useRef<Window | null>(null);
  const mountedRef = useRef(true);

  const stopPolling = useCallback(() => {
    if (pollingTimerRef.current) clearInterval(pollingTimerRef.current);
    pollingTimerRef.current = undefined;
  }, []);

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
    };
  }, [reload, stopPolling]);

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

      {snapshot?.automaticWeComBotCount ? (
        <section className="account-identity-strip" aria-label="企微机器人自动授权">
          <span><Bot size={20} /></span>
          <div>
            <strong>企微机器人无需绑定</strong>
            <small>{snapshot.automaticWeComBotCount} 个企业共享机器人由管理员在连接器管理中维护</small>
          </div>
          <p><ShieldCheck size={14} />MCP 登录后按可信企微身份与机器人可见范围自动筛选</p>
        </section>
      ) : null}

      <div className="account-integration-grid">
        {(snapshot?.applications || []).map((application) => (
          <AccountIntegrationCard
            application={application}
            busy={requestState?.applicationId === application.id}
            action={requestState?.applicationId === application.id ? requestState.action : undefined}
            onAuthorize={() => authorize(application)}
            onDisconnect={() => disconnect(application)}
            key={application.id}
          />
        ))}
      </div>

      {!snapshot?.applications.length && !snapshot?.automaticWeComBotCount ? (
        <div className="account-integration-loading">
          <Link2 size={20} />
          <span>当前没有需要个人绑定的企业集成。</span>
        </div>
      ) : null}
    </>
  );
}

function AccountIntegrationCard({
  application,
  busy,
  action,
  onAuthorize,
  onDisconnect,
}: {
  application: EmployeeIntegrationApplication;
  busy: boolean;
  action?: RequestState["action"];
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
