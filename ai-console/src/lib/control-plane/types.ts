export type ServiceId =
  | "global-gateway"
  | "agent-runtime"
  | "llm-gateway"
  | "open-connector"
  | "silverbullet"
  | "postgres"
  | "jaeger"
  | "promptfoo";

export type ServiceStatus =
  | "healthy"
  | "degraded"
  | "offline"
  | "unconfigured"
  | "idle"
  | "checking";

export type ServiceGroup =
  | "gateway"
  | "runtime"
  | "model"
  | "connection"
  | "knowledge"
  | "data"
  | "quality"
  | "observability";

export type ProbeConfig =
  | { type: "http"; path: string; endpointEnv?: string; defaultEndpoint?: string }
  | { type: "tcp"; hostEnv: string; portEnv: string }
  | { type: "manual" };

export type ServiceDefinition = {
  id: ServiceId;
  name: string;
  product: string;
  description: string;
  group: ServiceGroup;
  endpointEnv?: string;
  defaultEndpoint?: string;
  version: string;
  probe: ProbeConfig;
  docsUrl: string;
  capabilities: string[];
};

export type ServiceConfig = {
  enabled: boolean;
  endpoint?: string;
  displayName?: string;
  notes?: string;
};

export type ServiceSnapshot = ServiceDefinition & {
  status: ServiceStatus;
  endpoint?: string;
  configured: boolean;
  latencyMs?: number;
  checkedAt?: string;
  detail: string;
};

export type ConsoleConfig = {
  environment: "development" | "staging" | "production";
  currency: "CNY" | "USD";
  monthlyBudget: number;
  services: Partial<Record<ServiceId, ServiceConfig>>;
  updatedAt: string;
};

export type ConsoleAction =
  | "check-health"
  | "sync-knowledge"
  | "run-evaluation"
  | "rotate-connection";

export type ActivityItem = {
  id: string;
  kind: "deploy" | "config" | "incident" | "evaluation" | "sync";
  title: string;
  detail: string;
  actor: string;
  createdAt: string;
};

export type RuntimeEventSnapshot = {
  id: string;
  eventType: string;
  agentId: string;
  createdAt: string;
};

export type RuntimeAgentSnapshot = {
  id: string;
  name: string;
  status: "ready" | "observed";
  modelAlias?: string | null;
  tools: string[];
  runCount: number;
  latestRunAt?: string | null;
};

export type ConnectorConnectionSnapshot = {
  id: string;
  service: string;
  connectionName: string;
  authType: string;
  configured: boolean;
  isDefault: boolean;
};

export type KnowledgeDocumentSnapshot = {
  name: string;
  relativePath: string;
  sizeBytes: number;
  modifiedAt: string;
};

export type TraceSnapshot = {
  traceId: string;
  serviceName: string;
  operationName: string;
  spanCount: number;
  durationMs: number;
  startedAt: string;
  status: "healthy" | "degraded";
};

export type ComponentDataSnapshot = {
  generatedAt: string;
  services: ServiceSnapshot[];
  runtime: {
    database: string;
    pgvector: string;
    databaseSizeBytes: number;
    eventCount: number;
    eventTypes: Record<string, number>;
    agents: RuntimeAgentSnapshot[];
    recentEvents: RuntimeEventSnapshot[];
  };
  modelGateway: {
    channelCount: number;
    modelCount: number;
    models: string[];
  };
  connector: {
    providerCount: number;
    appCount: number;
    authenticatedAppCount: number;
    connectionCount: number;
    recentRunCount: number;
    connections: ConnectorConnectionSnapshot[];
  };
  knowledge: {
    documentCount: number;
    totalBytes: number;
    latestModifiedAt?: string;
    documents: KnowledgeDocumentSnapshot[];
  };
  tracing: {
    serviceCount: number;
    recentTraceCount: number;
    spanCount: number;
    errorTraceCount: number;
    traces: TraceSnapshot[];
  };
  evaluation: {
    status: "running" | "idle";
    resultCount: number;
    detail: string;
  };
  errors: Record<string, string>;
};
