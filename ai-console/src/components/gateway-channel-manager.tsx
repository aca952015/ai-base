"use client";

import {
  BrainCircuit,
  CheckCircle2,
  FlaskConical,
  Globe2,
  KeyRound,
  Pencil,
  Plus,
  RefreshCw,
  Route,
  Save,
  Trash2,
  X,
} from "lucide-react";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { createPortal } from "react-dom";

import {
  gatewayProviderOptions,
  type GatewayChannel,
  type GatewayChannelDraft,
  type GatewayChannelsSnapshot,
  type GatewayChannelTestResult,
  type GatewayProvider,
} from "@/lib/control-plane/gateway";

type EditableChannel = Omit<GatewayChannel, "models"> & {
  modelsText: string;
  apiKey: string;
  removeApiKey: boolean;
};

type RequestState = "idle" | "saving" | "saved" | "error";
type ModelSyncResult = { ok: boolean; message: string };

function modelsToText(channel: GatewayChannel) {
  return channel.models
    .map((model) => model.publicName === model.upstreamName
      ? model.publicName
      : `${model.publicName}=${model.upstreamName}`)
    .join("\n");
}

function toEditable(channel: GatewayChannel): EditableChannel {
  return { ...channel, modelsText: modelsToText(channel), apiKey: "", removeApiKey: false };
}

function parseModels(value: string) {
  return value.split(/\n|,/)
    .map((line) => line.trim())
    .filter(Boolean)
    .map((line) => {
      const separator = line.indexOf("=");
      if (separator < 0) return { publicName: line, upstreamName: line };
      return {
        publicName: line.slice(0, separator).trim(),
        upstreamName: line.slice(separator + 1).trim(),
      };
    });
}

function toDraft(channel: EditableChannel): GatewayChannelDraft {
  return {
    id: channel.id,
    name: channel.name,
    provider: channel.provider,
    baseUrl: channel.baseUrl,
    enabled: channel.enabled,
    models: parseModels(channel.modelsText),
    apiKey: channel.apiKey || undefined,
    removeApiKey: channel.removeApiKey,
  };
}

function providerOption(provider: GatewayProvider) {
  return gatewayProviderOptions.find((option) => option.value === provider) ?? gatewayProviderOptions[0];
}

export function GatewayChannelManager({ initialChannels }: { initialChannels: GatewayChannel[] }) {
  const [channels, setChannels] = useState<EditableChannel[]>(() => initialChannels.map(toEditable));
  const [editingChannel, setEditingChannel] = useState<EditableChannel>();
  const [isCreatingChannel, setIsCreatingChannel] = useState(false);
  const [state, setState] = useState<RequestState>("idle");
  const [message, setMessage] = useState("");
  const [testingId, setTestingId] = useState<string>();
  const [syncingId, setSyncingId] = useState<string>();
  const [testResults, setTestResults] = useState<Record<string, GatewayChannelTestResult>>({});
  const [modelSyncResults, setModelSyncResults] = useState<Record<string, ModelSyncResult>>({});
  const drawerRef = useRef<HTMLElement>(null);

  const summary = useMemo(() => ({
    enabled: channels.filter((channel) => channel.enabled).length,
    models: channels.filter((channel) => channel.enabled)
      .reduce((count, channel) => count + parseModels(channel.modelsText).length, 0),
  }), [channels]);
  const editingId = editingChannel?.id;

  const closeEditor = useCallback(() => {
    if (editingId) {
      setModelSyncResults((current) => {
        const next = { ...current };
        delete next[editingId];
        return next;
      });
    }
    setEditingChannel(undefined);
    setIsCreatingChannel(false);
  }, [editingId]);

  useEffect(() => {
    let ignore = false;
    async function loadChannels() {
      try {
        const response = await fetch("/api/llm-gateway/channels", { cache: "no-store" });
        if (!response.ok) throw new Error("读取渠道失败");
        const snapshot = await response.json() as GatewayChannelsSnapshot;
        if (!ignore) {
          setChannels(snapshot.channels.map(toEditable));
          setState("idle");
          setMessage("");
        }
      } catch (error) {
        if (!ignore) {
          setState("error");
          setMessage(error instanceof Error ? error.message : "读取渠道失败");
        }
      }
    }
    loadChannels();
    return () => { ignore = true; };
  }, []);

  useEffect(() => {
    if (!editingId) return;
    const previouslyFocused = document.activeElement instanceof HTMLElement ? document.activeElement : undefined;
    const previousOverflow = document.body.style.overflow;
    document.body.style.overflow = "hidden";
    const frame = requestAnimationFrame(() => {
      drawerRef.current?.querySelector<HTMLElement>("[data-drawer-autofocus]")?.focus();
    });

    function handleKeyDown(event: KeyboardEvent) {
      if (event.key === "Escape") {
        closeEditor();
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
  }, [closeEditor, editingId]);

  function updateChannel(id: string, patch: Partial<EditableChannel>) {
    if (editingChannel?.id === id) {
      setEditingChannel((current) => current?.id === id ? { ...current, ...patch } : current);
    } else {
      setChannels((current) => current.map((channel) => channel.id === id ? { ...channel, ...patch } : channel));
    }
    setModelSyncResults((current) => {
      const next = { ...current };
      delete next[id];
      return next;
    });
    setState("idle");
  }

  function changeProvider(channel: EditableChannel, provider: GatewayProvider) {
    const previous = providerOption(channel.provider);
    const next = providerOption(provider);
    updateChannel(channel.id, {
      provider,
      name: channel.name === previous.defaultName ? next.defaultName : channel.name,
      baseUrl: !channel.baseUrl || channel.baseUrl === previous.defaultBaseUrl
        ? next.defaultBaseUrl
        : channel.baseUrl,
    });
  }

  function addChannel() {
    const option = gatewayProviderOptions[0];
    const now = new Date().toISOString();
    const id = `channel-${crypto.randomUUID()}`;
    setEditingChannel({
      id,
      name: option.defaultName,
      provider: option.value,
      baseUrl: option.defaultBaseUrl,
      enabled: true,
      modelsText: "gpt-4.1-mini",
      apiKey: "",
      removeApiKey: false,
      keyConfigured: false,
      createdAt: now,
      updatedAt: now,
    });
    setIsCreatingChannel(true);
    setState("idle");
    setMessage("");
  }

  async function persistChannels(nextChannels: EditableChannel[], closeEditorOnSuccess = false) {
    setState("saving");
    setMessage("正在验证渠道并生成 Envoy 配置…");
    try {
      const response = await fetch("/api/llm-gateway/channels", {
        method: "PUT",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ channels: nextChannels.map(toDraft) }),
      });
      const payload = await response.json() as GatewayChannelsSnapshot & { message?: string; error?: string; details?: string[] };
      if (!response.ok) throw new Error(payload.details?.join("；") || payload.error || "保存渠道失败");
      setChannels(payload.channels.map(toEditable));
      if (closeEditorOnSuccess) {
        setEditingChannel(undefined);
        setIsCreatingChannel(false);
      }
      setState("saved");
      setMessage(payload.message || "渠道已保存，网关正在自动重载。 ");
    } catch (error) {
      setState("error");
      setMessage(error instanceof Error ? error.message : "保存渠道失败");
    }
  }

  async function saveChannels() {
    const nextChannels = editingChannel
      ? isCreatingChannel
        ? [...channels, editingChannel]
        : channels.map((channel) => channel.id === editingChannel.id ? editingChannel : channel)
      : channels;
    await persistChannels(nextChannels, true);
  }

  async function setChannelEnabled(id: string, enabled: boolean) {
    await persistChannels(channels.map((channel) => channel.id === id ? { ...channel, enabled } : channel));
  }

  async function removeChannel(id: string) {
    const channel = channels.find((item) => item.id === id);
    if (!channel || !window.confirm(`确认删除渠道“${channel.name}”？删除后将立即应用到 Envoy。`)) return;
    await persistChannels(channels.filter((channel) => channel.id !== id));
  }

  async function requestChannelProbe(channel: EditableChannel) {
    const response = await fetch("/api/llm-gateway/channels", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ channel: toDraft(channel) }),
    });
    const payload = await response.json() as GatewayChannelTestResult & { error?: string; details?: string[] };
    if (!response.ok) throw new Error(payload.details?.join("；") || payload.error || "连接测试失败");
    return payload;
  }

  async function testChannel(channel: EditableChannel) {
    setTestingId(channel.id);
    setTestResults((current) => {
      const next = { ...current };
      delete next[channel.id];
      return next;
    });
    try {
      const payload = await requestChannelProbe(channel);
      setTestResults((current) => ({ ...current, [channel.id]: payload }));
    } catch (error) {
      setTestResults((current) => ({
        ...current,
        [channel.id]: {
          ok: false,
          latencyMs: 0,
          message: error instanceof Error ? error.message : "连接测试失败",
          discoveredModels: [],
        },
      }));
    } finally {
      setTestingId(undefined);
    }
  }

  async function syncModels(channel: EditableChannel) {
    setSyncingId(channel.id);
    setModelSyncResults((current) => {
      const next = { ...current };
      delete next[channel.id];
      return next;
    });
    try {
      const payload = await requestChannelProbe(channel);
      if (!payload.ok) throw new Error(payload.message);
      const models = Array.from(new Set(payload.discoveredModels.map((model) => model.trim()).filter(Boolean)));
      if (models.length === 0) throw new Error("连接成功，但未获取到可用模型");
      updateChannel(channel.id, { modelsText: models.join("\n") });
      setModelSyncResults((current) => ({
        ...current,
        [channel.id]: { ok: true, message: `已同步 ${models.length} 个模型` },
      }));
    } catch (error) {
      setModelSyncResults((current) => ({
        ...current,
        [channel.id]: { ok: false, message: error instanceof Error ? error.message : "同步模型失败" },
      }));
    } finally {
      setSyncingId(undefined);
    }
  }

  return (
    <>
      <section className="model-gateway-summary" aria-label="大模型网关摘要">
        <article>
          <span><BrainCircuit size={17} /></span>
          <div><strong>{channels.length}</strong><small>个渠道 · {summary.enabled} 个启用</small></div>
        </article>
        <article>
          <span><Route size={17} /></span>
          <div><strong>{summary.models}</strong><small>个模型路由</small></div>
        </article>
      </section>

      <section className="portal-group gateway-resource-section" aria-labelledby="gateway-channel-management-title">
        <header className="portal-group__header">
          <div>
            <h2 id="gateway-channel-management-title">渠道管理</h2>
            <p>配置上游服务、发布模型和路由状态。</p>
          </div>
          <div className="gateway-resource-actions">
            <button className="button button--secondary" type="button" onClick={addChannel} disabled={state === "saving"}>
              <Plus size={15} aria-hidden="true" />添加渠道
            </button>
          </div>
        </header>

        {message ? (
          <p className={`gateway-channel-message${state === "error" ? " is-error" : ""}`} aria-live="polite">
            {state === "saved" ? <CheckCircle2 size={15} aria-hidden="true" /> : null}{message}
          </p>
        ) : null}

      <div className="gateway-channel-grid">
        {channels.map((channel) => {
          const option = providerOption(channel.provider);
          const models = parseModels(channel.modelsText);
          const testResult = testResults[channel.id];
          return (
            <article className={`gateway-channel-tile${channel.enabled ? " is-enabled" : ""}`} key={channel.id}>
              <div className="gateway-channel-tile__top">
                <span className="gateway-channel-tile__icon" aria-hidden="true"><Globe2 size={18} /></span>
                <div><strong>{channel.name || "未命名渠道"}</strong><small>{option.label}</small></div>
                <span className={`gateway-channel-state${channel.enabled ? " is-enabled" : ""}`}>{channel.enabled ? "参与路由" : "已停用"}</span>
              </div>

              <p className="gateway-channel-endpoint" title={channel.baseUrl}>{channel.baseUrl}</p>

              <div className="gateway-channel-metrics">
                <span><strong>{models.length}</strong> 个模型</span>
                <span>{channel.keyConfigured && !channel.removeApiKey ? <CheckCircle2 size={13} /> : <KeyRound size={13} />}{channel.keyConfigured && !channel.removeApiKey ? "密钥已保存" : "密钥未配置"}</span>
              </div>

              <div className="gateway-model-tags" aria-label="发布模型">
                {models.slice(0, 3).map((model) => <span key={`${model.publicName}-${model.upstreamName}`}>{model.publicName}</span>)}
                {models.length > 3 ? <span>+{models.length - 3}</span> : null}
                {models.length === 0 ? <em>尚未声明模型</em> : null}
              </div>

              {testResult ? <p className={`gateway-test-result${testResult.ok ? " is-success" : " is-error"}`} role="status">{testResult.message}{testResult.latencyMs ? ` · ${testResult.latencyMs} ms` : ""}</p> : null}

              <div className="gateway-channel-tile__actions">
                <label className="switch-control">
                  <input type="checkbox" checked={channel.enabled} onChange={(event) => void setChannelEnabled(channel.id, event.target.checked)} disabled={state === "saving"} />
                  <span aria-hidden="true" />
                  <span className="sr-only">启用{channel.name}</span>
                </label>
                <button className="button button--secondary" type="button" onClick={() => testChannel(channel)} disabled={testingId === channel.id}>
                  {testingId === channel.id ? <RefreshCw className="is-spinning" size={14} /> : <FlaskConical size={14} />}
                  {testingId === channel.id ? "测试中" : "测试"}
                </button>
                <button className="button button--secondary" type="button" onClick={() => { setEditingChannel({ ...channel }); setIsCreatingChannel(false); }}><Pencil size={14} />编辑</button>
                <button className="gateway-remove-button" type="button" onClick={() => void removeChannel(channel.id)} disabled={state === "saving"} aria-label={`移除${channel.name}`}><Trash2 size={15} /></button>
              </div>
            </article>
          );
        })}

        <button className="gateway-channel-add-card" type="button" onClick={addChannel} disabled={state === "saving"}>
          <span><Plus size={19} aria-hidden="true" /></span>
          <strong>{channels.length === 0 ? "创建第一个渠道" : "添加渠道"}</strong>
          <small>接入 OpenAI、Anthropic 或兼容服务</small>
        </button>
      </div>

      {editingChannel ? createPortal(
        <div className="gateway-channel-drawer-backdrop" onMouseDown={(event) => { if (event.target === event.currentTarget) closeEditor(); }}>
          <aside className="gateway-channel-drawer" ref={drawerRef} role="dialog" aria-modal="true" aria-labelledby="gateway-channel-editor-title">
            <div className="gateway-channel-editor__header">
              <div><span className="card-kicker">渠道配置</span><h3 id="gateway-channel-editor-title">{isCreatingChannel ? "新增" : "编辑"} {editingChannel.name || "未命名渠道"}</h3><p>{isCreatingChannel ? "保存并应用成功后，渠道才会加入列表。" : "修改会保留在当前草稿中，保存后应用到网关。"}</p></div>
              <button type="button" data-drawer-autofocus onClick={closeEditor} aria-label="关闭渠道编辑"><X size={17} /></button>
            </div>

            <div className="gateway-channel-drawer__body">
              <div className="gateway-channel-fields">
                <label className="field-label"><span>渠道名称</span><input value={editingChannel.name} onChange={(event) => updateChannel(editingChannel.id, { name: event.target.value })} /></label>
                <label className="field-label"><span>协议类型</span><select value={editingChannel.provider} onChange={(event) => changeProvider(editingChannel, event.target.value as GatewayProvider)}>{gatewayProviderOptions.map((option) => <option value={option.value} key={option.value}>{option.label}</option>)}</select></label>
                <label className="field-label gateway-channel-field--wide"><span>上游 Base URL</span><input className="mono-input" type="url" value={editingChannel.baseUrl} onChange={(event) => updateChannel(editingChannel.id, { baseUrl: event.target.value })} /></label>
                <label className="field-label gateway-channel-field--key"><span>API Key</span><input type="password" autoComplete="new-password" placeholder={editingChannel.keyConfigured && !editingChannel.removeApiKey ? "已配置；留空保持不变" : "输入渠道 API Key"} value={editingChannel.apiKey} onChange={(event) => updateChannel(editingChannel.id, { apiKey: event.target.value, removeApiKey: false })} /></label>
                <div className="field-label gateway-channel-field--models">
                  <div className="gateway-model-field__label">
                    <label htmlFor={`gateway-models-${editingChannel.id}`}>发布模型（每行一个，可用 alias=upstream）</label>
                    <button
                      className="gateway-model-sync-button"
                      type="button"
                      onClick={() => syncModels(editingChannel)}
                      disabled={syncingId === editingChannel.id || testingId === editingChannel.id || state === "saving"}
                      aria-label="从渠道同步模型"
                      title="从渠道同步模型"
                    >
                      <RefreshCw className={syncingId === editingChannel.id ? "is-spinning" : undefined} size={14} />
                    </button>
                  </div>
                  <textarea id={`gateway-models-${editingChannel.id}`} rows={6} placeholder={"gpt-4.1-mini\nchat-fast=deepseek-chat"} value={editingChannel.modelsText} onChange={(event) => updateChannel(editingChannel.id, { modelsText: event.target.value })} />
                  {modelSyncResults[editingChannel.id] ? (
                    <span className={`gateway-model-sync-status${modelSyncResults[editingChannel.id].ok ? " is-success" : " is-error"}`} role="status">
                      {modelSyncResults[editingChannel.id].message}
                    </span>
                  ) : null}
                </div>
              </div>

              <div className="gateway-channel-drawer__secret">
                <div className="gateway-key-state">
                  {editingChannel.keyConfigured && !editingChannel.removeApiKey ? <><CheckCircle2 size={14} />服务端已保存密钥</> : <><KeyRound size={14} />密钥尚未保存</>}
                  {editingChannel.keyConfigured ? <button type="button" onClick={() => updateChannel(editingChannel.id, { removeApiKey: !editingChannel.removeApiKey, apiKey: "" })}>{editingChannel.removeApiKey ? "撤销清除" : "清除密钥"}</button> : null}
                </div>
              </div>
            </div>

            <div className="gateway-channel-editor__footer">
              <button className="button button--secondary" type="button" onClick={() => testChannel(editingChannel)} disabled={testingId === editingChannel.id}>
                {testingId === editingChannel.id ? <RefreshCw className="is-spinning" size={14} /> : <FlaskConical size={14} />}{testingId === editingChannel.id ? "测试中" : "测试连接"}
              </button>
              <button className="button button--secondary" type="button" onClick={closeEditor}>{isCreatingChannel ? "取消" : "收起"}</button>
              <button className="button button--primary" type="button" onClick={saveChannels} disabled={state === "saving"}>
                <Save size={14} />{state === "saving" ? "保存中" : isCreatingChannel ? "添加并应用" : "保存并应用"}
              </button>
            </div>
          </aside>
        </div>,
        document.body,
      ) : null}

      </section>
    </>
  );
}
