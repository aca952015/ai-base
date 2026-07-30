import { describe, expect, it } from "vitest";

import { validateLightRagConfigInput } from "./lightrag-config";

const validInput = {
  llmModel: "qwen",
  embeddingModel: "BAAI/bge-m3",
  embeddingTokenLimit: 8192,
  summaryLanguage: "Chinese",
  maxAsync: 4,
  maxParallelInsert: 2,
  chunkSize: 1200,
  chunkOverlapSize: 100,
};

describe("LightRAG config validation", () => {
  it("accepts a valid gateway-backed configuration", () => {
    expect(validateLightRagConfigInput(validInput)).toEqual({
      ok: true,
      value: validInput,
    });
  });

  it("rejects unknown fields and invalid chunk overlap", () => {
    const result = validateLightRagConfigInput({
      ...validInput,
      chunkOverlapSize: 1200,
      apiKey: "must-not-be-accepted",
    });
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.errors).toContain("unsupported field: apiKey");
      expect(result.errors).toContain("chunkOverlapSize must be between 0 and 1199");
    }
  });

  it("rejects model names that are not valid gateway aliases", () => {
    const result = validateLightRagConfigInput({
      ...validInput,
      llmModel: "model with spaces",
    });
    expect(result.ok).toBe(false);
  });
});
