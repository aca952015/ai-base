export type GatewayProvider = "openai" | "anthropic" | "openai-compatible";

export type GatewayModelRoute = {
  publicName: string;
  upstreamName: string;
};

export type GatewayChannel = {
  id: string;
  name: string;
  provider: GatewayProvider;
  baseUrl: string;
  enabled: boolean;
  models: GatewayModelRoute[];
  keyConfigured: boolean;
  createdAt: string;
  updatedAt: string;
};

export type GatewayChannelDraft = Omit<
  GatewayChannel,
  "keyConfigured" | "createdAt" | "updatedAt"
> & {
  apiKey?: string;
  removeApiKey?: boolean;
};

export type GatewayChannelsSnapshot = {
  channels: GatewayChannel[];
  updatedAt: string;
  revision: string;
};

export type GatewayChannelTestResult = {
  ok: boolean;
  status?: number;
  latencyMs: number;
  message: string;
  discoveredModels: string[];
};

export const gatewayProviderOptions: Array<{
  value: GatewayProvider;
  label: string;
  defaultName: string;
  defaultBaseUrl: string;
  description: string;
}> = [
  {
    value: "openai",
    label: "OpenAI",
    defaultName: "OpenAI",
    defaultBaseUrl: "https://api.openai.com/v1",
    description: "OpenAI 官方 API",
  },
  {
    value: "anthropic",
    label: "Anthropic",
    defaultName: "Anthropic",
    defaultBaseUrl: "https://api.anthropic.com/v1",
    description: "Anthropic Messages API，由网关转换为 OpenAI 兼容调用",
  },
  {
    value: "openai-compatible",
    label: "OpenAI-compatible",
    defaultName: "自定义兼容渠道",
    defaultBaseUrl: "https://api.deepseek.com/v1",
    description: "DeepSeek、DashScope、Ollama 或其他 OpenAI 兼容端点",
  },
];
