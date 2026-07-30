"use client";

import {
  CheckCircle2,
  Database,
  Languages,
  Network,
  RefreshCw,
  Save,
  Sparkles,
  TriangleAlert,
} from "lucide-react";
import Link from "next/link";
import { useMemo, useState } from "react";

import type {
  LightRagApplyResult,
  LightRagConfigDraft,
  LightRagConfigSnapshot,
  LightRagGatewayModel,
} from "@/lib/control-plane/lightrag";

type RequestState = "idle" | "saving" | "saved" | "error";

function toDraft(snapshot: LightRagConfigSnapshot): LightRagConfigDraft {
  const { config } = snapshot;
  return {
    llmModel: config.llmModel,
    embeddingModel: config.embeddingModel,
    embeddingTokenLimit: config.embeddingTokenLimit,
    summaryLanguage: config.summaryLanguage,
    maxAsync: config.maxAsync,
    maxParallelInsert: config.maxParallelInsert,
    chunkSize: config.chunkSize,
    chunkOverlapSize: config.chunkOverlapSize,
  };
}

export function LightRagSettingsForm({
  initialSnapshot,
}: {
  initialSnapshot: LightRagConfigSnapshot;
}) {
  const [snapshot, setSnapshot] = useState(initialSnapshot);
  const [draft, setDraft] = useState(() => toDraft(initialSnapshot));
  const [state, setState] = useState<RequestState>("idle");
  const [message, setMessage] = useState("修改后将验证模型并重新加载 LightRAG。");
  const groupedModels = useMemo(() => {
    const groups = new Map<string, LightRagGatewayModel[]>();
    for (const model of snapshot.availableModels) {
      const existing = groups.get(model.channelName) || [];
      existing.push(model);
      groups.set(model.channelName, existing);
    }
    return Array.from(groups.entries());
  }, [snapshot.availableModels]);
  const availableNames = useMemo(
    () => new Set(snapshot.availableModels.map((model) => model.name)),
    [snapshot.availableModels],
  );
  const dirty = Object.entries(draft).some(
    ([key, value]) => snapshot.config[key as keyof LightRagConfigDraft] !== value,
  );

  function update<K extends keyof LightRagConfigDraft>(key: K, value: LightRagConfigDraft[K]) {
    setDraft((current) => ({ ...current, [key]: value }));
    setState("idle");
    setMessage("配置尚未应用。");
  }

  async function applyConfig() {
    setState("saving");
    setMessage("正在验证网关模型和 Embedding 维度，并重新加载 LightRAG…");
    try {
      const response = await fetch("/api/settings/lightrag", {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(draft),
      });
      const payload = await response.json() as LightRagApplyResult & {
        error?: string;
        details?: string[];
      };
      if (!response.ok) {
        throw new Error(payload.details?.join("；") || payload.error || "应用 LightRAG 配置失败");
      }
      setSnapshot(payload);
      setDraft(toDraft(payload));
      setState("saved");
      setMessage(payload.embeddingChanged
        ? "配置已应用。Embedding 模型或维度已变化，请在知识工作台重建既有文档索引。"
        : payload.message);
    } catch (error) {
      setState("error");
      setMessage(error instanceof Error ? error.message : "应用 LightRAG 配置失败");
    }
  }

  function modelOptions(current: string) {
    return (
      <>
        {!availableNames.has(current) ? <option value={current}>{current}（当前渠道不可用）</option> : null}
        {groupedModels.map(([channelName, models]) => (
          <optgroup label={channelName} key={channelName}>
            {models.map((model) => <option value={model.name} key={`${model.channelId}:${model.name}`}>{model.name}</option>)}
          </optgroup>
        ))}
      </>
    );
  }

  return (
    <div className="lightrag-settings">
      <div className="lightrag-settings__runtime" aria-label="LightRAG 当前配置">
        <article>
          <span className="lightrag-settings__icon"><Sparkles size={18} /></span>
          <div><small>LLM 模型</small><strong>{snapshot.config.llmModel}</strong></div>
        </article>
        <article>
          <span className="lightrag-settings__icon is-purple"><Network size={18} /></span>
          <div><small>Embedding 模型</small><strong>{snapshot.config.embeddingModel}</strong></div>
        </article>
        <article>
          <span className="lightrag-settings__icon is-green"><Database size={18} /></span>
          <div><small>向量维度</small><strong>{snapshot.config.embeddingDimension}</strong></div>
        </article>
      </div>

      {snapshot.availableModels.length === 0 ? (
        <div className="lightrag-settings__warning" role="alert">
          <TriangleAlert size={18} />
          <div><strong>大模型网关尚未发布可用模型</strong><p>先在模型配置中启用渠道并发布模型，LightRAG 不接受手工输入的模型名称。</p></div>
          <Link className="button button--secondary" href="/model-channels">前往模型配置</Link>
        </div>
      ) : null}

      <section className="lightrag-settings__section" aria-labelledby="lightrag-models">
        <div className="lightrag-settings__heading">
          <div><h2 id="lightrag-models">模型</h2><p>候选项只来自大模型网关中已启用渠道发布的模型。</p></div>
          <Link className="text-link" href="/model-channels">管理网关模型</Link>
        </div>
        <div className="lightrag-settings__fields">
          <label className="field-label">
            <span>LLM 模型</span>
            <select value={draft.llmModel} onChange={(event) => update("llmModel", event.target.value)}>
              {modelOptions(draft.llmModel)}
            </select>
            <small>用于实体关系抽取、摘要和最终回答。</small>
          </label>
          <label className="field-label">
            <span>Embedding 模型</span>
            <select value={draft.embeddingModel} onChange={(event) => update("embeddingModel", event.target.value)}>
              {modelOptions(draft.embeddingModel)}
            </select>
            <small>保存时会发起最小向量请求并自动识别维度。</small>
          </label>
          <label className="field-label">
            <span>Embedding Token 上限</span>
            <input type="number" min="256" max="131072" value={draft.embeddingTokenLimit} onChange={(event) => update("embeddingTokenLimit", Number(event.target.value))} />
          </label>
          <label className="field-label">
            <span>摘要语言</span>
            <select value={draft.summaryLanguage} onChange={(event) => update("summaryLanguage", event.target.value as "Chinese" | "English")}>
              <option value="Chinese">中文</option>
              <option value="English">英文</option>
            </select>
          </label>
        </div>
      </section>

      <section className="lightrag-settings__section" aria-labelledby="lightrag-index">
        <div className="lightrag-settings__heading">
          <div><h2 id="lightrag-index">索引与并发</h2><p>调整新文档的切片策略和处理并发；既有索引不会自动重建。</p></div>
        </div>
        <div className="lightrag-settings__fields lightrag-settings__fields--four">
          <label className="field-label">
            <span>切片大小</span>
            <input type="number" min="256" max="8000" value={draft.chunkSize} onChange={(event) => update("chunkSize", Number(event.target.value))} />
          </label>
          <label className="field-label">
            <span>切片重叠</span>
            <input type="number" min="0" max={Math.max(0, draft.chunkSize - 1)} value={draft.chunkOverlapSize} onChange={(event) => update("chunkOverlapSize", Number(event.target.value))} />
          </label>
          <label className="field-label">
            <span>LLM 最大并发</span>
            <input type="number" min="1" max="32" value={draft.maxAsync} onChange={(event) => update("maxAsync", Number(event.target.value))} />
          </label>
          <label className="field-label">
            <span>并行导入数</span>
            <input type="number" min="1" max="16" value={draft.maxParallelInsert} onChange={(event) => update("maxParallelInsert", Number(event.target.value))} />
          </label>
        </div>
      </section>

      <div className="lightrag-settings__footer">
        <p className={state === "error" ? "form-message form-message--error" : "form-message"} aria-live="polite">
          {state === "saved" ? <CheckCircle2 size={15} /> : state === "saving" ? <RefreshCw className="is-spinning" size={15} /> : null}
          {message}
        </p>
        <button
          className="button button--primary"
          type="button"
          onClick={applyConfig}
          disabled={state === "saving" || !dirty || snapshot.availableModels.length === 0}
        >
          <Save size={16} />
          {state === "saving" ? "应用中" : "保存并应用"}
        </button>
      </div>

      <div className="lightrag-settings__meta">
        <Languages size={15} />
        <span>上次应用：{new Date(snapshot.config.updatedAt).toLocaleString("zh-CN")} · Revision {snapshot.config.revision.slice(0, 8)}</span>
      </div>
    </div>
  );
}
