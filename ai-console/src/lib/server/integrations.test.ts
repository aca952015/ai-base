import { afterEach, beforeEach, describe, expect, it } from "vitest";

import type {
  EmployeeConnectorBinding,
  IntegrationApplication,
} from "../control-plane/integrations";
import {
  buildEmployeeIntegrationsSnapshot,
  buildEnterpriseIntegrationsSnapshot,
  decryptIntegrationSecret,
  encryptIntegrationSecret,
  hashWeComUserId,
  parseWeComVisibleUserIdHashes,
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
  it("always returns the supported platform groups in a stable order", () => {
    const applications: IntegrationApplication[] = [
      {
        id: "019fd023-aec6-7cd0-8d43-29f9523a63bd",
        platform: "dingtalk",
        name: "钉钉协同应用",
        appId: "ding-app",
        note: "用于经销商订单协同",
        actionIds: [],
        active: true,
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
        actionIds: ["feishu.search_bitable_records"],
        active: true,
        secretConfigured: true,
        createdAt: "2026-07-23T02:00:00.000Z",
        updatedAt: "2026-07-23T02:00:00.000Z",
      },
    ];

    const snapshot = buildEnterpriseIntegrationsSnapshot(
      applications,
      "2026-07-23T03:00:00.000Z",
      {
        feishu: {
          actions: [{
            id: "feishu.search_bitable_records",
            name: "search_bitable_records",
            description: "Read Bitable records.",
            providerPermissions: ["bitable:app:readonly"],
          }],
          defaultActionIds: ["feishu.search_bitable_records"],
          oauthBaseScopes: ["offline_access"],
        },
      },
    );

    expect(snapshot.groups.map((group) => group.platform)).toEqual([
      "feishu",
      "dingtalk",
    ]);
    expect(snapshot.groups[0].applications).toEqual([applications[1]]);
    expect(snapshot.groups[1].applications).toEqual([applications[0]]);
    expect(snapshot.groups[0].actions.map((action) => action.id)).toEqual([
      "feishu.search_bitable_records",
    ]);
    expect(snapshot.groups[0].oauthBaseScopes).toEqual(["offline_access"]);
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
    expect(decryptIntegrationSecret(first)).toBe(secret);
  });

  it("excludes shared WeCom bots from employee binding cards", () => {
    const applications: IntegrationApplication[] = [
      {
        id: "019fd023-aec6-7cd0-8d43-29f9523a63c1",
        platform: "feishu",
        name: "WorkBuddy 生产应用",
        appId: "feishu-production",
        note: "生产员工使用",
        actionIds: ["feishu.search_bitable_records"],
        active: true,
        secretConfigured: true,
        createdAt: "2026-07-23T01:00:00.000Z",
        updatedAt: "2026-07-23T01:00:00.000Z",
      },
      {
        id: "019fd023-aec6-7cd0-8d43-29f9523a63c2",
        platform: "feishu",
        name: "WorkBuddy 测试应用",
        appId: "feishu-staging",
        note: "测试员工使用",
        actionIds: ["feishu.get_document"],
        active: false,
        secretConfigured: true,
        createdAt: "2026-07-23T02:00:00.000Z",
        updatedAt: "2026-07-23T02:00:00.000Z",
      },
      {
        id: "019fd023-aec6-7cd0-8d43-29f9523a63c3",
        platform: "wecom_bot",
        name: "销售助手机器人",
        appId: "wecom-bot-production",
        note: "供销售员工绑定",
        actionIds: ["wecom_bot.get_userlist"],
        active: true,
        secretConfigured: true,
        createdAt: "2026-07-23T03:00:00.000Z",
        updatedAt: "2026-07-23T03:00:00.000Z",
      },
      {
        id: "019fd023-aec6-7cd0-8d43-29f9523a63c4",
        platform: "dingtalk",
        name: "钉钉审批应用",
        appId: "dingtalk-approval",
        note: "",
        actionIds: [],
        active: true,
        secretConfigured: true,
        createdAt: "2026-07-23T04:00:00.000Z",
        updatedAt: "2026-07-23T04:00:00.000Z",
      },
    ];
    const binding: EmployeeConnectorBinding = {
      id: "019fd023-aec6-7cd0-8d43-29f9523a63d1",
      applicationId: applications[0].id,
      platform: "feishu",
      service: "feishu",
      connectionName: "usr_employee",
      status: "connected",
      connectedAt: "2026-07-23T04:00:00.000Z",
      updatedAt: "2026-07-23T04:00:00.000Z",
    };

    const snapshot = buildEmployeeIntegrationsSnapshot(
      applications,
      [binding],
      { name: "employee01", email: "employee01@bluetron.cn" },
      "2026-07-23T05:00:00.000Z",
    );

    expect(snapshot.applications.map((application) => application.id)).toEqual([
      applications[0].id,
      applications[1].id,
      applications[3].id,
    ]);
    expect(snapshot.applications.map((application) => application.platformDisplayName)).toEqual([
      "飞书",
      "飞书",
      "钉钉",
    ]);
    expect(snapshot.applications.map((application) => application.bindingMode)).toEqual([
      "oauth2",
      "oauth2",
      "unsupported",
    ]);
    expect(snapshot.applications[0].binding).toEqual(binding);
    expect(snapshot.applications[1].binding).toBeUndefined();
    expect(snapshot.applications[1].active).toBe(false);
    expect(snapshot.identity.email).toBe("employee01@bluetron.cn");
    expect(snapshot.automaticWeComBotCount).toBe(1);
  });

  it("hashes only WeCom user IDs returned by a successful visibility response", () => {
    const hashes = parseWeComVisibleUserIdHashes({
      errcode: 0,
      errmsg: "ok",
      userlist: [
        { userid: "ZhangSan", name: "张三" },
        { userid: "LiSi", name: "李四" },
        { userid: "" },
        { name: "missing" },
      ],
    });

    expect(hashes).toEqual(new Set([
      hashWeComUserId("ZhangSan"),
      hashWeComUserId("LiSi"),
    ]));
    expect(hashes.has(hashWeComUserId("zhangsan"))).toBe(false);
    expect(() => parseWeComVisibleUserIdHashes({ errcode: 40013, userlist: [] }))
      .toThrow("企微机器人可见范围查询失败");
  });
});
