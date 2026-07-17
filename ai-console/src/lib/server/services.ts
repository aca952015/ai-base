import net from "node:net";

import { serviceCatalog } from "../control-plane/catalog";
import type {
  ConsoleConfig,
  ServiceConfig,
  ServiceDefinition,
  ServiceSnapshot,
} from "../control-plane/types";

const PROBE_TIMEOUT_MS = 2_000;

type TcpTarget = { host: string; port: number };
type Environment = Record<string, string | undefined>;

function configuredService(
  definition: ServiceDefinition,
  config: ConsoleConfig,
): ServiceConfig {
  return config.services[definition.id] ?? { enabled: true };
}

export function resolveHttpEndpoint(
  definition: ServiceDefinition,
  serviceConfig: ServiceConfig,
  environment: Environment = process.env,
) {
  return (
    serviceConfig.endpoint ||
    (definition.endpointEnv ? environment[definition.endpointEnv] : undefined) ||
    definition.defaultEndpoint
  );
}

export function resolveTcpTarget(
  definition: ServiceDefinition,
  serviceConfig: ServiceConfig,
  environment: Environment = process.env,
): TcpTarget | undefined {
  if (serviceConfig.endpoint) {
    try {
      const value = serviceConfig.endpoint.includes("://")
        ? new URL(serviceConfig.endpoint)
        : new URL(`tcp://${serviceConfig.endpoint}`);
      const port = Number(value.port || (value.protocol.startsWith("postgres") ? 5432 : 0));
      if (value.hostname && Number.isInteger(port) && port > 0 && port <= 65_535) {
        return { host: value.hostname, port };
      }
    } catch {
      return undefined;
    }
  }

  if (definition.probe.type !== "tcp") {
    return undefined;
  }
  const host = environment[definition.probe.hostEnv] || "localhost";
  const port = Number(environment[definition.probe.portEnv] || "5432");
  return Number.isInteger(port) && port > 0 && port <= 65_535
    ? { host, port }
    : undefined;
}

function offlineSnapshot(
  definition: ServiceDefinition,
  endpoint: string | undefined,
  startedAt: number,
  detail: string,
): ServiceSnapshot {
  return {
    ...definition,
    endpoint,
    configured: Boolean(endpoint),
    status: "offline",
    latencyMs: Date.now() - startedAt,
    checkedAt: new Date().toISOString(),
    detail,
  };
}

async function checkHttpService(
  definition: ServiceDefinition,
  serviceConfig: ServiceConfig,
): Promise<ServiceSnapshot> {
  const startedAt = Date.now();
  const baseEndpoint = resolveHttpEndpoint(definition, serviceConfig);
  if (!baseEndpoint || definition.probe.type !== "http") {
    return offlineSnapshot(definition, baseEndpoint, startedAt, "未配置健康检查地址");
  }

  let healthUrl: URL;
  try {
    healthUrl = new URL(definition.probe.path, `${baseEndpoint.replace(/\/$/, "")}/`);
  } catch {
    return offlineSnapshot(definition, baseEndpoint, startedAt, "健康检查地址无效");
  }

  try {
    const response = await fetch(healthUrl, {
      method: "GET",
      cache: "no-store",
      signal: AbortSignal.timeout(PROBE_TIMEOUT_MS),
    });
    return {
      ...definition,
      endpoint: baseEndpoint,
      configured: true,
      status: response.ok ? "healthy" : "degraded",
      latencyMs: Date.now() - startedAt,
      checkedAt: new Date().toISOString(),
      detail: response.ok ? `HTTP ${response.status}` : `健康检查返回 HTTP ${response.status}`,
    };
  } catch (error) {
    const detail = error instanceof Error && error.name === "TimeoutError"
      ? "健康检查超时（2 秒）"
      : "无法连接服务";
    return offlineSnapshot(definition, baseEndpoint, startedAt, detail);
  }
}

export function probeTcp(target: TcpTarget, timeoutMs = PROBE_TIMEOUT_MS): Promise<number> {
  const startedAt = Date.now();
  return new Promise((resolve, reject) => {
    const socket = net.createConnection(target);
    const finish = (error?: Error) => {
      socket.destroy();
      if (error) reject(error);
      else resolve(Date.now() - startedAt);
    };

    socket.setTimeout(timeoutMs);
    socket.once("connect", () => finish());
    socket.once("timeout", () => finish(new Error("TCP probe timed out")));
    socket.once("error", finish);
  });
}

async function checkTcpService(
  definition: ServiceDefinition,
  serviceConfig: ServiceConfig,
): Promise<ServiceSnapshot> {
  const startedAt = Date.now();
  const target = resolveTcpTarget(definition, serviceConfig);
  const endpoint = target ? `${target.host}:${target.port}` : serviceConfig.endpoint;
  if (!target) {
    return offlineSnapshot(definition, endpoint, startedAt, "TCP 地址无效");
  }

  try {
    const latencyMs = await probeTcp(target);
    return {
      ...definition,
      endpoint,
      configured: true,
      status: "healthy",
      latencyMs,
      checkedAt: new Date().toISOString(),
      detail: "TCP 连接成功",
    };
  } catch {
    return offlineSnapshot(definition, endpoint, startedAt, "无法建立 TCP 连接");
  }
}

export async function checkService(
  definition: ServiceDefinition,
  config: ConsoleConfig,
): Promise<ServiceSnapshot> {
  const serviceConfig = configuredService(definition, config);
  if (!serviceConfig.enabled) {
    return {
      ...definition,
      endpoint: serviceConfig.endpoint,
      configured: false,
      status: "unconfigured",
      checkedAt: new Date().toISOString(),
      detail: "服务已禁用",
    };
  }

  if (definition.probe.type === "manual") {
    return {
      ...definition,
      endpoint: serviceConfig.endpoint,
      configured: true,
      status: "idle",
      checkedAt: new Date().toISOString(),
      detail: "由 CI 按需运行，当前空闲",
    };
  }
  return definition.probe.type === "http"
    ? checkHttpService(definition, serviceConfig)
    : checkTcpService(definition, serviceConfig);
}

export function checkServices(config: ConsoleConfig) {
  return Promise.all(serviceCatalog.map((service) => checkService(service, config)));
}
