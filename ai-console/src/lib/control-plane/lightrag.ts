import type { GatewayProvider } from "./gateway";

export type LightRagConfig = {
  llmModel: string;
  embeddingModel: string;
  embeddingDimension: number;
  embeddingTokenLimit: number;
  summaryLanguage: "Chinese" | "English";
  maxAsync: number;
  maxParallelInsert: number;
  chunkSize: number;
  chunkOverlapSize: number;
  revision: string;
  updatedAt: string;
};

export type LightRagConfigDraft = Omit<
  LightRagConfig,
  "embeddingDimension" | "revision" | "updatedAt"
>;

export type LightRagGatewayModel = {
  name: string;
  channelId: string;
  channelName: string;
  provider: GatewayProvider;
};

export type LightRagConfigSnapshot = {
  ready: boolean;
  pid?: number;
  config: LightRagConfig;
  availableModels: LightRagGatewayModel[];
};

export type LightRagApplyResult = LightRagConfigSnapshot & {
  message: string;
  embeddingChanged: boolean;
};
