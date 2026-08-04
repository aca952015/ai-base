"use client";

import { Check, ExternalLink, Globe2, Mail, Save, ShieldCheck } from "lucide-react";
import { useMemo, useState } from "react";

import type {
  WeComAuthenticationSettings,
  WeComAuthenticationSnapshot,
} from "@/lib/control-plane/types";

type SaveState = "idle" | "saving" | "saved" | "error";

export function WeComAuthSettingsForm({
  initialSnapshot,
}: {
  initialSnapshot: WeComAuthenticationSnapshot;
}) {
  const [settings, setSettings] = useState<WeComAuthenticationSettings>({
    publicBaseUrl: initialSnapshot.publicBaseUrl,
    callbackMode: initialSnapshot.callbackMode,
    relayCallbackUrl: initialSnapshot.relayCallbackUrl,
    emailDomain: initialSnapshot.emailDomain,
  });
  const [updatedAt, setUpdatedAt] = useState(initialSnapshot.updatedAt);
  const [state, setState] = useState<SaveState>("idle");
  const [message, setMessage] = useState("修改会用于后续新发起的企业微信登录，不需要重启认证桥接。");
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
      const response = await fetch("/api/settings/wecom-auth", {
        method: "PUT",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(settings),
      });
      const payload = (await response.json()) as WeComAuthenticationSnapshot & {
        error?: string;
        details?: string[];
      };
      if (!response.ok) {
        throw new Error(payload.details?.[0] ?? payload.error ?? "保存失败");
      }
      setSettings({
        publicBaseUrl: payload.publicBaseUrl,
        callbackMode: payload.callbackMode,
        relayCallbackUrl: payload.relayCallbackUrl,
        emailDomain: payload.emailDomain,
      });
      setUpdatedAt(payload.updatedAt);
      setState("saved");
      setMessage("配置已保存，并会立即用于后续新登录流程。");
    } catch (error) {
      setState("error");
      setMessage(error instanceof Error ? error.message : "保存失败");
    }
  }

  return (
    <form className="component-settings" onSubmit={(event) => { event.preventDefault(); void saveSettings(); }}>
      <div className="component-settings__runtime" aria-label="企业微信认证当前配置">
        <article>
          <span className="component-settings__icon"><Globe2 size={18} /></span>
          <div><small>公开认证入口</small><strong>{settings.publicBaseUrl}</strong></div>
        </article>
        <article>
          <span className="component-settings__icon is-purple"><ExternalLink size={18} /></span>
          <div><small>企业微信回调方式</small><strong>{settings.callbackMode === "relay" ? "公网中继" : "直接回调"}</strong></div>
        </article>
        <article>
          <span className="component-settings__icon is-green"><Mail size={18} /></span>
          <div><small>身份邮箱域</small><strong>{settings.emailDomain}</strong></div>
        </article>
      </div>

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
          <small className="component-settings__meta">最近保存：{new Date(updatedAt).toLocaleString("zh-CN")}</small>
        </div>
        <button className="button button--primary" type="submit" disabled={state === "saving"}>
          <Save size={16} aria-hidden="true" />
          {state === "saving" ? "保存中" : "保存并应用"}
        </button>
      </div>
    </form>
  );
}
