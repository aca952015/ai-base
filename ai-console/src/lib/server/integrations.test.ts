import { afterEach, beforeEach, describe, expect, it } from "vitest";

import type { IntegrationApplication } from "../control-plane/integrations";
import {
  buildEnterpriseIntegrationsSnapshot,
  encryptIntegrationSecret,
} from "./integrations";

const originalEncryptionKey = process.env.AI_CONSOLE_SECRET_ENCRYPTION_KEY;

beforeEach(() => {
  process.env.AI_CONSOLE_SECRET_ENCRYPTION_KEY = "test-integration-secret-encryption-key-32";
});

afterEach(() => {
  if (originalEncryptionKey === undefined) delete process.env.AI_CONSOLE_SECRET_ENCRYPTION_KEY;
  else process.env.AI_CONSOLE_SECRET_ENCRYPTION_KEY = originalEncryptionKey;
});

describe("enterprise integration store", () => {
  it("always returns the three supported platform groups in a stable order", () => {
    const applications: IntegrationApplication[] = [
      {
        id: "019fd023-aec6-7cd0-8d43-29f9523a63bd",
        platform: "dingtalk",
        name: "钉钉协同应用",
        appId: "ding-app",
        note: "用于经销商订单协同",
        secretConfigured: true,
        createdAt: "2026-07-23T01:00:00.000Z",
        updatedAt: "2026-07-23T01:00:00.000Z",
      },
      {
        id: "019fd023-aec6-7cd0-8d43-29f9523a63be",
        platform: "feishu",
        name: "飞书协同应用",
        appId: "feishu-app",
        note: "用于项目交付风险分析",
        secretConfigured: true,
        createdAt: "2026-07-23T02:00:00.000Z",
        updatedAt: "2026-07-23T02:00:00.000Z",
      },
    ];

    const snapshot = buildEnterpriseIntegrationsSnapshot(
      applications,
      "2026-07-23T03:00:00.000Z",
    );

    expect(snapshot.groups.map((group) => group.platform)).toEqual([
      "feishu",
      "wecom",
      "dingtalk",
    ]);
    expect(snapshot.groups[0].applications).toEqual([applications[1]]);
    expect(snapshot.groups[1].applications).toEqual([]);
    expect(snapshot.groups[2].applications).toEqual([applications[0]]);
    expect(snapshot.updatedAt).toBe("2026-07-23T03:00:00.000Z");
  });

  it("encrypts App Secret with a randomized authenticated ciphertext", () => {
    const secret = "fs-secret-do-not-return";
    const first = encryptIntegrationSecret(secret);
    const second = encryptIntegrationSecret(secret);

    expect(first).toMatch(/^v1\.[^.]+\.[^.]+\.[^.]+$/);
    expect(second).toMatch(/^v1\.[^.]+\.[^.]+\.[^.]+$/);
    expect(first).not.toContain(secret);
    expect(first).not.toBe(second);
  });
});
