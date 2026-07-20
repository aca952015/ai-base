export type GatewayMcpServer = {
  id: string;
  name: string;
  namespace: string;
  url: string;
  enabled: boolean;
  managed: boolean;
  authHeader: string;
  toolIncludes: string[];
  toolExcludes: string[];
  keyConfigured: boolean;
  createdAt: string;
  updatedAt: string;
};

export type GatewayMcpServerDraft = Omit<
  GatewayMcpServer,
  "keyConfigured" | "managed" | "createdAt" | "updatedAt"
> & {
  apiKey?: string;
  removeApiKey?: boolean;
};

export type GatewayMcpServersSnapshot = {
  servers: GatewayMcpServer[];
  updatedAt: string;
  revision: string;
};

export type GatewayMcpTool = {
  name: string;
  description?: string;
};

export type GatewayMcpServerTestResult = {
  ok: boolean;
  status?: number;
  latencyMs: number;
  message: string;
  discoveredTools: string[];
  tools: GatewayMcpTool[];
};
