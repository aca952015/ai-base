import type {
  LightRagApplyResult,
  LightRagConfig,
  LightRagConfigDraft,
  LightRagConfigSnapshot,
  LightRagGatewayModel,
} from "../control-plane/lightrag";
import { readGatewayChannels } from "./gateway-config";

type JsonObject = Record<string, unknown>;

export type LightRagConfigValidation =
  | { ok: true; value: LightRagConfigDraft }
  | { ok: false; errors: string[] };

function isObject(value: unknown): value is JsonObject {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function readInteger(
  value: unknown,
  field: string,
  minimum: number,
  maximum: number,
  errors: string[],
) {
  if (!Number.isInteger(value) || Number(value) < minimum || Number(value) > maximum) {
    errors.push(`${field} must be between ${minimum} and ${maximum}`);
    return minimum;
  }
  return Number(value);
}

function readModel(value: unknown, field: string, errors: string[]) {
  const model = typeof value === "string" ? value.trim() : "";
  if (!model || model.length > 200 || /\s/.test(model)) {
    errors.push(`${field} must be a configured gateway model without spaces`);
  }
  return model;
}

export function validateLightRagConfigInput(input: unknown): LightRagConfigValidation {
  if (!isObject(input)) {
    return { ok: false, errors: ["request body must be an object"] };
  }
  const allowed = new Set([
    "llmModel",
    "embeddingModel",
    "embeddingTokenLimit",
    "summaryLanguage",
    "maxAsync",
    "maxParallelInsert",
    "chunkSize",
    "chunkOverlapSize",
  ]);
  const errors = Object.keys(input)
    .filter((key) => !allowed.has(key))
    .map((key) => `unsupported field: ${key}`);
  const chunkSize = readInteger(input.chunkSize, "chunkSize", 256, 8000, errors);
  const chunkOverlapSize = readInteger(
    input.chunkOverlapSize,
    "chunkOverlapSize",
    0,
    Math.min(2000, chunkSize - 1),
    errors,
  );
  const summaryLanguage = input.summaryLanguage;
  if (summaryLanguage !== "Chinese" && summaryLanguage !== "English") {
    errors.push("summaryLanguage must be Chinese or English");
  }

  const value: LightRagConfigDraft = {
    llmModel: readModel(input.llmModel, "llmModel", errors),
    embeddingModel: readModel(input.embeddingModel, "embeddingModel", errors),
    embeddingTokenLimit: readInteger(
      input.embeddingTokenLimit,
      "embeddingTokenLimit",
      256,
      131072,
      errors,
    ),
    summaryLanguage: summaryLanguage === "English" ? "English" : "Chinese",
    maxAsync: readInteger(input.maxAsync, "maxAsync", 1, 32, errors),
    maxParallelInsert: readInteger(
      input.maxParallelInsert,
      "maxParallelInsert",
      1,
      16,
      errors,
    ),
    chunkSize,
    chunkOverlapSize,
  };
  return errors.length > 0 ? { ok: false, errors } : { ok: true, value };
}

function adminBaseUrl() {
  return (process.env.LIGHTRAG_ADMIN_URL || "http://localhost:9622").replace(/\/$/, "");
}

function adminToken() {
  const token = process.env.LIGHTRAG_ADMIN_TOKEN?.trim();
  if (!token) throw new Error("LightRAG 内部管理令牌未配置");
  return token;
}

async function controlRequest<T>(path: string, init?: RequestInit, timeout = 8_000): Promise<T> {
  const response = await fetch(`${adminBaseUrl()}${path}`, {
    ...init,
    headers: {
      Authorization: `Bearer ${adminToken()}`,
      ...(init?.headers || {}),
    },
    cache: "no-store",
    signal: AbortSignal.timeout(timeout),
  });
  const payload = await response.json().catch(() => ({})) as T & { error?: string };
  if (!response.ok) throw new Error(payload.error || `LightRAG 控制面返回 HTTP ${response.status}`);
  return payload;
}

export async function readLightRagGatewayModels(): Promise<LightRagGatewayModel[]> {
  const snapshot = await readGatewayChannels();
  return snapshot.channels
    .filter((channel) => channel.enabled)
    .flatMap((channel) => channel.models.map((model) => ({
      name: model.publicName,
      channelId: channel.id,
      channelName: channel.name,
      provider: channel.provider,
    })))
    .sort((left, right) => left.name.localeCompare(right.name));
}

async function readControlSnapshot() {
  return controlRequest<{
    ready: boolean;
    pid?: number;
    config: LightRagConfig;
  }>("/config");
}

export async function readLightRagConfig(): Promise<LightRagConfigSnapshot> {
  const [snapshot, availableModels] = await Promise.all([
    readControlSnapshot(),
    readLightRagGatewayModels(),
  ]);
  return { ...snapshot, availableModels };
}

async function probeEmbeddingDimension(model: string) {
  const base = (process.env.LLM_GATEWAY_URL || "http://localhost:8080").replace(/\/$/, "");
  const response = await fetch(`${base}/v1/embeddings`, {
    method: "POST",
    headers: {
      Authorization: "Bearer ai-base-internal",
      "Content-Type": "application/json",
    },
    body: JSON.stringify({ model, input: "dimension probe" }),
    cache: "no-store",
    signal: AbortSignal.timeout(30_000),
  });
  const payload = await response.json().catch(() => ({})) as {
    data?: Array<{ embedding?: unknown[] }>;
    error?: { message?: string } | string;
  };
  if (!response.ok) {
    const detail = typeof payload.error === "string" ? payload.error : payload.error?.message;
    throw new Error(`模型 ${model} 不能用于 Embedding${detail ? `：${detail}` : ""}`);
  }
  const dimension = payload.data?.[0]?.embedding?.length || 0;
  if (!dimension) throw new Error(`模型 ${model} 未返回有效 Embedding 向量`);
  return dimension;
}

export async function applyLightRagConfig(
  draft: LightRagConfigDraft,
): Promise<LightRagApplyResult> {
  const [current, availableModels] = await Promise.all([
    readControlSnapshot(),
    readLightRagGatewayModels(),
  ]);
  const published = new Set(availableModels.map((model) => model.name));
  const missing = [draft.llmModel, draft.embeddingModel].filter((model) => !published.has(model));
  if (missing.length > 0) {
    throw new Error(`所选模型未由启用的大模型渠道发布：${missing.join("、")}`);
  }

  const embeddingDimension = await probeEmbeddingDimension(draft.embeddingModel);
  const embeddingChanged = current.config.embeddingModel !== draft.embeddingModel
    || current.config.embeddingDimension !== embeddingDimension;
  const applied = await controlRequest<{
    ready: boolean;
    pid?: number;
    config: LightRagConfig;
    message: string;
  }>("/config", {
    method: "PUT",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ ...draft, embeddingDimension }),
  }, 120_000);

  return {
    ...applied,
    availableModels,
    embeddingChanged,
  };
}
