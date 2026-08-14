"use client";

import { Check, KeyRound, Save, ShieldCheck } from "lucide-react";
import { useState } from "react";

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
    relayCallbackUrl: initialSnapshot.relayCallbackUrl,
  });
  const [secretConfigured, setSecretConfigured] = useState(initialSnapshot.secretConfigured);
  const [updatedAt, setUpdatedAt] = useState(initialSnapshot.updatedAt);
  const [state, setState] = useState<SaveState>(initialError ? "error" : "idle");
  const [message, setMessage] = useState(initialError || "修改会立即用于后续新发起的企业微信中继认证，不需要重启 AI Base。");

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
        relayCallbackUrl: payload.relayCallbackUrl,
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
          <div><h2 id="wecom-auth-routing">公网认证中继</h2><p>企业微信授权和身份交换只在中继完成；AI Base 通过一次性加密请求关联当前平台账号。</p></div>
        </div>
        <div className="component-settings__fields">
          <label className="field-label">
            <span>公网认证中继回调地址</span>
            <input
              type="url"
              required
              value={settings.relayCallbackUrl}
              placeholder="http://tn1.cofly-ai.cn/callbacks/wecom"
              onChange={(event) => update({ relayCallbackUrl: event.target.value })}
            />
            <small>必须以 <code>/callbacks/wecom</code> 结尾。企微可信 IP 应配置为该中继的固定公网出口。</small>
          </label>
        </div>
        <div className="component-settings__effective">
          <ShieldCheck size={16} aria-hidden="true" />
          <span><strong>当前生效回调</strong><code>{settings.relayCallbackUrl || "尚未配置"}</code></span>
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
