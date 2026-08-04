import { randomUUID } from "node:crypto";
import { mkdir, readFile, rename, unlink, writeFile } from "node:fs/promises";
import path from "node:path";

import { serviceCatalog } from "../control-plane/catalog";
import type {
  ConsoleConfig,
  ServiceConfig,
  ServiceId,
  WeComAuthenticationSettings,
  WeComAuthenticationSnapshot,
} from "../control-plane/types";

const CONFIG_FILE_NAME = "config.json";
const MAX_MONTHLY_BUDGET = 1_000_000_000;
const MAX_DISPLAY_NAME_LENGTH = 100;
const MAX_NOTES_LENGTH = 2_000;
const MAX_URL_LENGTH = 2_048;
const MAX_EMAIL_DOMAIN_LENGTH = 253;

export const DEFAULT_WECOM_AUTHENTICATION_SETTINGS: WeComAuthenticationSettings = {
  publicBaseUrl: "http://127.0.0.1:8080/wecom-oidc",
  callbackMode: "direct",
  emailDomain: "bluetron.cn",
};

type JsonObject = Record<string, unknown>;

export type ConfigPatch = Partial<
  Pick<ConsoleConfig, "environment" | "currency" | "monthlyBudget">
> & {
  services?: Partial<Record<ServiceId, Partial<ServiceConfig>>>;
  authentication?: {
    wecom: WeComAuthenticationSettings;
  };
};

export type ValidationResult =
  | { ok: true; value: ConfigPatch }
  | { ok: false; errors: string[] };

function isObject(value: unknown): value is JsonObject {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function unknownKeys(value: JsonObject, allowed: readonly string[]) {
  const allowedKeys = new Set(allowed);
  return Object.keys(value).filter((key) => !allowedKeys.has(key));
}

function validateOptionalString(
  value: unknown,
  field: string,
  maxLength: number,
  errors: string[],
) {
  if (value !== undefined && (typeof value !== "string" || value.length > maxLength)) {
    errors.push(`${field} must be a string of at most ${maxLength} characters`);
  }
}

function normalizeHttpUrl(
  value: unknown,
  field: string,
  errors: string[],
  options: { httpsOnly?: boolean } = {},
) {
  const label = field === "publicBaseUrl" ? "AI Base 公开认证入口" : "公网中继回调地址";
  if (typeof value !== "string" || value.length === 0 || value.length > MAX_URL_LENGTH) {
    errors.push(`${label}必须是非空 URL，且不超过 ${MAX_URL_LENGTH} 个字符`);
    return undefined;
  }
  try {
    const parsed = new URL(value);
    if (
      !["http:", "https:"].includes(parsed.protocol)
      || (options.httpsOnly && parsed.protocol !== "https:")
      || parsed.username
      || parsed.password
      || parsed.search
      || parsed.hash
    ) {
      throw new Error("unsupported URL");
    }
    return parsed.toString().replace(/\/$/, "");
  } catch {
    errors.push(`${label}必须是绝对 ${options.httpsOnly ? "HTTPS" : "HTTP(S)"} 地址，且不能包含账号、查询参数或片段`);
    return undefined;
  }
}

function normalizeEmailDomain(value: unknown, errors: string[]) {
  if (typeof value !== "string") {
    errors.push("企业邮箱域必须是 DNS 域名");
    return undefined;
  }
  const normalized = value.trim().toLowerCase();
  if (
    normalized.length === 0
    || normalized.length > MAX_EMAIL_DOMAIN_LENGTH
    || !/^(?=.{1,253}$)(?:[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/.test(normalized)
  ) {
    errors.push("企业邮箱域必须是有效的 DNS 域名");
    return undefined;
  }
  return normalized;
}

export type WeComAuthenticationValidationResult =
  | { ok: true; value: WeComAuthenticationSettings }
  | { ok: false; errors: string[] };

export function validateWeComAuthenticationSettings(
  input: unknown,
): WeComAuthenticationValidationResult {
  if (!isObject(input)) {
    return { ok: false, errors: ["request body must be a JSON object"] };
  }
  const errors = unknownKeys(input, [
    "publicBaseUrl",
    "callbackMode",
    "relayCallbackUrl",
    "emailDomain",
  ]).map((key) => `unsupported field: ${key}`);
  const publicBaseUrl = normalizeHttpUrl(input.publicBaseUrl, "publicBaseUrl", errors);
  const callbackMode = input.callbackMode;
  if (callbackMode !== "direct" && callbackMode !== "relay") {
    errors.push("回调方式必须是直接回调或公网中继");
  }
  let relayCallbackUrl: string | undefined;
  if (callbackMode === "relay") {
    relayCallbackUrl = normalizeHttpUrl(
      input.relayCallbackUrl,
      "relayCallbackUrl",
      errors,
    );
  } else if (
    input.relayCallbackUrl !== undefined
    && (typeof input.relayCallbackUrl !== "string" || input.relayCallbackUrl.length > MAX_URL_LENGTH)
  ) {
    errors.push(`公网中继回调地址不能超过 ${MAX_URL_LENGTH} 个字符`);
  }
  const emailDomain = normalizeEmailDomain(input.emailDomain, errors);
  if (errors.length || !publicBaseUrl || !emailDomain || (callbackMode !== "direct" && callbackMode !== "relay")) {
    return { ok: false, errors };
  }
  return {
    ok: true,
    value: {
      publicBaseUrl,
      callbackMode,
      ...(callbackMode === "relay" && relayCallbackUrl ? { relayCallbackUrl } : {}),
      emailDomain,
    },
  };
}

export function resolveWeComCallbackUrl(settings: WeComAuthenticationSettings) {
  return settings.callbackMode === "relay" && settings.relayCallbackUrl
    ? settings.relayCallbackUrl
    : `${settings.publicBaseUrl}/callback`;
}

export function getWeComAuthenticationSnapshot(config: ConsoleConfig): WeComAuthenticationSnapshot {
  return {
    ...config.authentication.wecom,
    effectiveCallbackUrl: resolveWeComCallbackUrl(config.authentication.wecom),
    updatedAt: config.updatedAt,
  };
}

export function validateConfigPatch(input: unknown): ValidationResult {
  if (!isObject(input)) {
    return { ok: false, errors: ["request body must be a JSON object"] };
  }

  const errors: string[] = [];
  for (const key of unknownKeys(input, [
    "environment",
    "currency",
    "monthlyBudget",
    "services",
  ])) {
    errors.push(`unsupported field: ${key}`);
  }

  if (
    input.environment !== undefined &&
    !["development", "staging", "production"].includes(String(input.environment))
  ) {
    errors.push("environment must be development, staging, or production");
  }
  if (input.currency !== undefined && !["CNY", "USD"].includes(String(input.currency))) {
    errors.push("currency must be CNY or USD");
  }
  if (
    input.monthlyBudget !== undefined &&
    (typeof input.monthlyBudget !== "number" ||
      !Number.isFinite(input.monthlyBudget) ||
      input.monthlyBudget < 0 ||
      input.monthlyBudget > MAX_MONTHLY_BUDGET)
  ) {
    errors.push(`monthlyBudget must be between 0 and ${MAX_MONTHLY_BUDGET}`);
  }

  if (input.services !== undefined) {
    if (!isObject(input.services)) {
      errors.push("services must be a JSON object");
    } else {
      const serviceIds = new Set(serviceCatalog.map((service) => service.id));
      for (const [serviceId, servicePatch] of Object.entries(input.services)) {
        if (!serviceIds.has(serviceId as ServiceId)) {
          errors.push(`unknown service: ${serviceId}`);
          continue;
        }
        if (!isObject(servicePatch)) {
          errors.push(`services.${serviceId} must be a JSON object`);
          continue;
        }
        for (const key of unknownKeys(servicePatch, [
          "enabled",
          "endpoint",
          "displayName",
          "notes",
        ])) {
          errors.push(`unsupported field: services.${serviceId}.${key}`);
        }
        if (servicePatch.enabled !== undefined && typeof servicePatch.enabled !== "boolean") {
          errors.push(`services.${serviceId}.enabled must be a boolean`);
        }
        if (servicePatch.endpoint !== undefined) {
          if (
            typeof servicePatch.endpoint !== "string" ||
            servicePatch.endpoint.length === 0 ||
            servicePatch.endpoint.length > 2_048
          ) {
            errors.push(`services.${serviceId}.endpoint must be a non-empty string`);
          }
        }
        validateOptionalString(
          servicePatch.displayName,
          `services.${serviceId}.displayName`,
          MAX_DISPLAY_NAME_LENGTH,
          errors,
        );
        validateOptionalString(
          servicePatch.notes,
          `services.${serviceId}.notes`,
          MAX_NOTES_LENGTH,
          errors,
        );
      }
    }
  }

  return errors.length === 0
    ? { ok: true, value: input as ConfigPatch }
    : { ok: false, errors };
}

export function createDefaultConfig(now = new Date()): ConsoleConfig {
  return {
    environment: "development",
    currency: "CNY",
    monthlyBudget: 20_000,
    services: Object.fromEntries(
      serviceCatalog.map((service) => [service.id, { enabled: true }]),
    ),
    authentication: {
      wecom: { ...DEFAULT_WECOM_AUTHENTICATION_SETTINGS },
    },
    updatedAt: now.toISOString(),
  };
}

export function applyConfigPatch(
  current: ConsoleConfig,
  patch: ConfigPatch,
  now = new Date(),
): ConsoleConfig {
  const services = { ...current.services };
  for (const [id, servicePatch] of Object.entries(patch.services ?? {})) {
    const serviceId = id as ServiceId;
    services[serviceId] = {
      ...(services[serviceId] ?? { enabled: true }),
      ...servicePatch,
    };
  }

  return {
    ...current,
    ...patch,
    services,
    updatedAt: now.toISOString(),
  };
}

export function getConfigPath() {
  const directory = process.env.AI_CONSOLE_DATA_DIR || path.join(process.cwd(), ".data");
  return path.join(directory, CONFIG_FILE_NAME);
}

async function writeConfigFile(config: ConsoleConfig) {
  const configPath = getConfigPath();
  await mkdir(path.dirname(configPath), { recursive: true });
  const temporaryPath = `${configPath}.${process.pid}.${randomUUID()}.tmp`;

  try {
    await writeFile(temporaryPath, `${JSON.stringify(config, null, 2)}\n`, "utf8");
    await rename(temporaryPath, configPath);
  } finally {
    await unlink(temporaryPath).catch(() => undefined);
  }
}

function migrateLegacyConfig(config: ConsoleConfig): ConsoleConfig {
  const services = { ...config.services } as Record<string, ServiceConfig>;
  const legacyBifrost = services.bifrost;
  if (!services["llm-gateway"] && legacyBifrost) {
    services["llm-gateway"] = legacyBifrost;
  }
  delete services.bifrost;
  if (!services.lightrag && services.silverbullet) {
    services.lightrag = services.silverbullet;
  }
  delete services.silverbullet;

  for (const service of serviceCatalog) {
    services[service.id] ??= { enabled: true };
  }
  const legacyConfig = config as ConsoleConfig & {
    authentication?: Partial<ConsoleConfig["authentication"]>;
  };
  const authentication = {
    wecom: legacyConfig.authentication?.wecom
      ? { ...legacyConfig.authentication.wecom }
      : { ...DEFAULT_WECOM_AUTHENTICATION_SETTINGS },
  };
  return { ...config, services, authentication } as ConsoleConfig;
}

export async function readConfig(): Promise<ConsoleConfig> {
  try {
    const stored = JSON.parse(await readFile(getConfigPath(), "utf8")) as ConsoleConfig;
    const migrated = migrateLegacyConfig(stored);
    if (JSON.stringify(stored) !== JSON.stringify(migrated)) {
      await writeConfigFile(migrated);
    }
    return migrated;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") {
      throw error;
    }
    const config = createDefaultConfig();
    await writeConfigFile(config);
    return config;
  }
}

export async function updateConfig(patch: ConfigPatch) {
  const config = applyConfigPatch(await readConfig(), patch);
  await writeConfigFile(config);
  return config;
}

export async function updateWeComAuthenticationSettings(
  settings: WeComAuthenticationSettings,
) {
  const config = await updateConfig({ authentication: { wecom: settings } });
  return getWeComAuthenticationSnapshot(config);
}
