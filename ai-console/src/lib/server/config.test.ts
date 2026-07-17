import { mkdtemp, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

import { describe, expect, it } from "vitest";

import {
  applyConfigPatch,
  createDefaultConfig,
  readConfig,
  validateConfigPatch,
} from "./config";

describe("config validation", () => {
  it("accepts and applies an allow-listed nested patch", () => {
    const validation = validateConfigPatch({
      environment: "staging",
      monthlyBudget: 2_500,
      services: { "llm-gateway": { enabled: false, notes: "maintenance" } },
    });
    expect(validation.ok).toBe(true);
    if (!validation.ok) return;

    const result = applyConfigPatch(
      createDefaultConfig(new Date("2026-01-01T00:00:00.000Z")),
      validation.value,
      new Date("2026-01-02T00:00:00.000Z"),
    );
    expect(result.environment).toBe("staging");
    expect(result.services["llm-gateway"]).toEqual({
      enabled: false,
      notes: "maintenance",
    });
    expect(result.updatedAt).toBe("2026-01-02T00:00:00.000Z");
  });

  it("rejects unsupported and invalid fields", () => {
    const validation = validateConfigPatch({
      updatedAt: "forged",
      monthlyBudget: -1,
      services: {
        postgres: { enabled: "yes", password: "secret" },
        unknown: { enabled: true },
      },
    });
    expect(validation.ok).toBe(false);
    if (validation.ok) return;
    expect(validation.errors).toEqual(expect.arrayContaining([
      "unsupported field: updatedAt",
      "monthlyBudget must be between 0 and 1000000000",
      "services.postgres.enabled must be a boolean",
      "unsupported field: services.postgres.password",
      "unknown service: unknown",
    ]));
  });
});

describe("config storage", () => {
  it("creates the default JSON config without leaving a temporary file", async () => {
    const directory = await mkdtemp(path.join(tmpdir(), "ai-console-config-"));
    const previousDirectory = process.env.AI_CONSOLE_DATA_DIR;
    process.env.AI_CONSOLE_DATA_DIR = directory;

    try {
      const config = await readConfig();
      const persisted = JSON.parse(
        await readFile(path.join(directory, "config.json"), "utf8"),
      );
      expect(persisted).toEqual(config);
      expect(await readdir(directory)).toEqual(["config.json"]);
      expect(await readConfig()).toEqual(config);
    } finally {
      if (previousDirectory === undefined) delete process.env.AI_CONSOLE_DATA_DIR;
      else process.env.AI_CONSOLE_DATA_DIR = previousDirectory;
      await rm(directory, { recursive: true, force: true });
    }
  });

  it("migrates the legacy Bifrost service key", async () => {
    const directory = await mkdtemp(path.join(tmpdir(), "ai-console-config-"));
    const previousDirectory = process.env.AI_CONSOLE_DATA_DIR;
    process.env.AI_CONSOLE_DATA_DIR = directory;

    try {
      await writeFile(path.join(directory, "config.json"), JSON.stringify({
        ...createDefaultConfig(new Date("2026-01-01T00:00:00.000Z")),
        services: { bifrost: { enabled: false, notes: "legacy" } },
      }), "utf8");
      const config = await readConfig();
      expect(config.services["llm-gateway"]).toEqual({ enabled: false, notes: "legacy" });
      expect("bifrost" in config.services).toBe(false);
    } finally {
      if (previousDirectory === undefined) delete process.env.AI_CONSOLE_DATA_DIR;
      else process.env.AI_CONSOLE_DATA_DIR = previousDirectory;
      await rm(directory, { recursive: true, force: true });
    }
  });
});
