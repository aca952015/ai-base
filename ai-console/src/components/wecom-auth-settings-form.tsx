"use client";

import { Check, KeyRound, Save, ShieldCheck } from "lucide-react";
import { useMemo, useState } from "react";

import type {
  WeComAuthenticationSettings,
  WeComAuthenticationSnapshot,
} from "@/lib/control-plane/types";

type SaveState = "idle" | "saving" | "saved" | "error";

function formatSavedAt(value: string) {
  const timestamp = Date.parse(value);
  if (Number.isNaN(timestamp)) {
    return "未知";
  }

  return new Date(timestamp + 8 * 60 * 60 * 1000).toISOString().slice(0, 19).replace("T", " ");
}

export function WeComAuthSettingsForm({
  initialSnapshot,
  initialError,
}: {
  initialSnapshot: WeComAuthenticationSnapshot;
  initialError?: string;
}) {
  const [settings, setSettings] = useState<WeComAuthenticationSettings>({
    corpId: initialSnapshot.corpId,
    appSecret: "",
    publicBaseUrl: initialSnapshot.publicBaseUrl,
    callbackMode: initialSnapshot.callbackMode,
    relayCallbackUrl: initialSnapshot.relayCallbackUrl,
    emailDomain: initialSnapshot.emailDomain,
  });
  const [secretConfigured, setSecretConfigured] = useState(initialSnapshot.secretConfigured);
  const [updatedAt, setUpdatedAt] = useState(initialSnapshot.updatedAt);
  const [state, setState] = useState<SaveState>(initialError ? "error" : "idle");
  const [message, setMessage] = useState(initialError || "修改会用于后续新发起的企业微信登录，不需要重启认证桥接。");
  const effectiveCallbackUrl = useMemo(
    () => settings.callbackMode === "relay" && settings.relayCallbackUrl
      ? settings.relayCallbackUrl
      : `${settings.publicBaseUrl.replace(/\/$/, "")}/callback`,
    [settings],
  );

  function update(patch: Partial<WeComAuthenticationSettings>) {
    setSettings((current) => ({ ...current, ...patch }));
    setState("idle");
    setMessage("配置尚未保存。");
  }

  async function saveSettings() {
    setState("saving");
    setMessage("正在验证并保存企业微信认证配置…");
    try {
      const response = await fetch("/api/integrations/wecom-authentication", {
        method: "PUT",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ ...settings, appSecret: settings.appSecret || undefined }),
      });
      const payload = (await response.json()) as WeComAuthenticationSnapshot & {
        error?: string;
        details?: string[];
      };
      if (!response.ok) {
        throw new Error(payload.details?.[0] ?? payload.error ?? "保存失败");
      }
      setSettings({
        corpId: payload.corpId,
        appSecret: "",
        publicBaseUrl: payload.publicBaseUrl,
        callbackMode: payload.callbackMode,
        relayCallbackUrl: payload.relayCallbackUrl,
        emailDomain: payload.emailDomain,
      });
      setSecretConfigured(payload.secretConfigured);
      setUpdatedAt(payload.updatedAt);
      setState("saved");
      setMessage("配置已保存，并会立即用于后续新登录流程。");
    } catch (error) {
      setState("error");
      setMessage(error instanceof Error ? error.message : "保存失败");
    }
  }

  return (
    <form id="wecom-authentication-form" className="component-settings" onSubmit={(event) => { event.preventDefault(); void saveSettings(); }}>
      <section className="component-settings__section" aria-labelledby="wecom-auth-credential">
        <div className="component-settings__heading">
          <div><h2 id="wecom-auth-credential">企业微信应用凭据</h2><p>这是 AI Base 唯一的企业微信系统认证配置；机器人凭据仍在连接器配置中维护。</p></div>
          <span className={`secret-state${secretConfigured ? " is-ready" : " is-warning"}`}>
            {secretConfigured ? <ShieldCheck size={14} /> : <KeyRound size={14} />}
            {secretConfigured ? "密钥已保存" : "密钥未配置"}
          </span>
        </div>
        <div className="component-settings__fields">
          <label className="field-label">
            <span>企业 ID（CorpID）</span>
            <input
              type="text"
              required
              value={settings.corpId}
              placeholder="wwxxxxxxxxxxxxxxxx"
              onChange={(event) => update({ corpId: event.target.value })}
              autoComplete="off"
            />
            <small>用于限定可信企业身份域，并与企微登录返回的员工 UserID 关联。</small>
          </label>
          <label className="field-label">
            <span>App Secret</span>
            <input
              type="password"
              required={!secretConfigured}
              value={settings.appSecret ?? ""}
              placeholder={secretConfigured ? "留空表示保留当前 Secret" : "填写企业微信应用的 App Secret"}
              onChange={(event) => update({ appSecret: event.target.value })}
              autoComplete="new-password"
            />
            <small>密钥只在服务端加密保存，读取和编辑时均不回显。</small>
          </label>
        </div>
      </section>

      <section className="component-settings__section" aria-labelledby="wecom-auth-routing">
        <div className="component-settings__heading">
          <div><h2 id="wecom-auth-routing">浏览器认证路由</h2><p>这些地址不包含密钥，由认证桥接在每次新登录时从 Console 内网读取。</p></div>
        </div>
        <div className="component-settings__fields">
          <label className="field-label">
            <span>AI Base 公开认证入口</span>
            <input
              type="url"
              required
              value={settings.publicBaseUrl}
              placeholder="https://ai.example.com/wecom-oidc"
              onChange={(event) => update({ publicBaseUrl: event.target.value })}
            />
            <small>必须是浏览器可访问的绝对 HTTP(S) 地址，不含查询参数或片段。</small>
          </label>
          <label className="field-label">
            <span>企业邮箱域</span>
            <input
              type="text"
              required
              inputMode="url"
              value={settings.emailDomain}
              placeholder="example.com"
              onChange={(event) => update({ emailDomain: event.target.value })}
            />
            <small>企微未返回企业邮箱时，用于生成稳定的员工登录邮箱。</small>
          </label>
        </div>
      </section>

      <section className="component-settings__section" aria-labelledby="wecom-auth-callback">
        <div className="component-settings__heading">
          <div><h2 id="wecom-auth-callback">企业微信回调</h2><p>内网或开发部署可使用公网中继；具有稳定公网入口时可直接回调 AI Base。</p></div>
        </div>
        <div className="component-settings__fields">
          <label className="field-label">
            <span>回调方式</span>
            <select
              value={settings.callbackMode}
              onChange={(event) => update({ callbackMode: event.target.value as WeComAuthenticationSettings["callbackMode"] })}
            >
              <option value="direct">直接回调 AI Base</option>
              <option value="relay">通过公网认证中继</option>
            </select>
            <small>直接回调会使用公开认证入口下的 `/callback`。</small>
          </label>
          <label className="field-label">
            <span>公网中继回调地址</span>
            <input
              type="url"
              required={settings.callbackMode === "relay"}
              disabled={settings.callbackMode !== "relay"}
              value={settings.relayCallbackUrl ?? ""}
              placeholder="https://auth.example.com/callbacks/wecom"
              onChange={(event) => update({ relayCallbackUrl: event.target.value })}
            />
            <small>必须是绝对 HTTP(S) 地址；正式公网部署应使用 HTTPS。</small>
          </label>
        </div>
        <div className="component-settings__effective">
          <ShieldCheck size={16} aria-hidden="true" />
          <span><strong>当前生效回调</strong><code>{effectiveCallbackUrl}</code></span>
        </div>
      </section>

      <div className="component-settings__footer">
        <div>
          <p aria-live="polite" className={state === "error" ? "form-message form-message--error" : "form-message"}>
            {state === "saved" ? <Check size={15} aria-hidden="true" /> : null}
            {message}
          </p>
          <small className="component-settings__meta">最近保存：{formatSavedAt(updatedAt)}</small>
        </div>
        <button className="button button--primary" type="submit" disabled={state === "saving"}>
          <Save size={16} aria-hidden="true" />
          {state === "saving" ? "保存中" : "保存并应用"}
        </button>
      </div>
    </form>
  );
}
