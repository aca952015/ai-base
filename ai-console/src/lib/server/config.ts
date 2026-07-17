import { randomUUID } from "node:crypto";
import { mkdir, readFile, rename, unlink, writeFile } from "node:fs/promises";
import path from "node:path";

import { serviceCatalog } from "../control-plane/catalog";
import type {
  ConsoleConfig,
  ServiceConfig,
  ServiceId,
} from "../control-plane/types";

const CONFIG_FILE_NAME = "config.json";
const MAX_MONTHLY_BUDGET = 1_000_000_000;
const MAX_DISPLAY_NAME_LENGTH = 100;
const MAX_NOTES_LENGTH = 2_000;

type JsonObject = Record<string, unknown>;

export type ConfigPatch = Partial<
  Pick<ConsoleConfig, "environment" | "currency" | "monthlyBudget">
> & {
  services?: Partial<Record<ServiceId, Partial<ServiceConfig>>>;
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

  for (const service of serviceCatalog) {
    services[service.id] ??= { enabled: true };
  }
  return { ...config, services } as ConsoleConfig;
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
