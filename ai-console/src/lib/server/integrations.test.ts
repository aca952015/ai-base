import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import type {
  EmployeeConnectorBinding,
  IntegrationApplication,
} from "../control-plane/integrations";
import {
  buildEmployeeAvailableConnections,
  buildEmployeeIntegrationsSnapshot,
  buildEnterpriseIntegrationsSnapshot,
  decryptIntegrationSecret,
  deriveTrustedWeComRelayIdentity,
  encryptIntegrationSecret,
  hashWeComCorpId,
  hashWeComUserId,
  personalWeComBotDisplayName,
  parseWeComBotPersonalActionIds,
  parseWeComVisibleUsers,
  parseWeComVisibleUserIdHashes,
  readWeComBotVisibleUsersWithRetry,
  readWeComBotVisibleUserIdsWithRetry,
} from "./integrations";
import { OpenConnectorError } from "./open-connector";

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
    expect(snapshot.wecomIdentity).toEqual({ linked: false, identities: [] });
    expect(snapshot.availableConnections).toEqual([]);
    expect(snapshot.automaticWeComBotCount).toBe(1);
  });

  it("builds the employee connection list from effective personal and shared Action grants", () => {
    const connections = buildEmployeeAvailableConnections([
      {
        service: "feishu",
        connectionName: "usr_employee",
        displayName: "employee01",
        accessMode: "account_bound",
        allowedActionIds: ["feishu.get_document"],
      },
      {
        service: "wecom_bot",
        connectionName: "sales-bot",
        displayName: "销售机器人",
        accessMode: "controlled_shared",
        allowedActionIds: ["wecom_bot.get_userlist"],
        policyIds: ["manual-grant"],
      },
      {
        service: "wecom_bot",
        connectionName: "sales-bot",
        displayName: "销售机器人",
        accessMode: "controlled_shared",
        allowedActionIds: ["wecom_bot.get_calendar"],
        policyIds: ["wecom-visibility:resource-id"],
      },
      {
        service: "wecom_bot",
        connectionName: "no-actions",
        displayName: "无权限机器人",
        accessMode: "controlled_shared",
        allowedActionIds: [],
        policyIds: ["manual-empty"],
      },
    ], [
      {
        service: "feishu",
        displayName: "飞书",
        actions: [{
          id: "feishu.get_document",
          name: "get_document",
          description: "读取文档",
          requiredScopes: [],
          providerPermissions: [],
        }],
      },
      {
        service: "wecom_bot",
        displayName: "企业微信机器人",
        actions: [{
          id: "wecom_bot.get_userlist",
          name: "get_userlist",
          description: "查询可见通讯录",
          requiredScopes: [],
          providerPermissions: [],
        }],
      },
    ]);

    expect(connections).toHaveLength(2);
    expect(connections.find((connection) => connection.service === "feishu")).toMatchObject({
      accessMode: "account_bound",
      authorizationSources: ["personal"],
      serviceDisplayName: "飞书",
      actions: [{ id: "feishu.get_document", name: "get_document", description: "读取文档" }],
    });
    expect(connections.find((connection) => connection.service === "wecom_bot")).toMatchObject({
      accessMode: "controlled_shared",
      authorizationSources: ["manual", "wecom_visibility"],
      actions: [
        { id: "wecom_bot.get_calendar", name: "get_calendar" },
        { id: "wecom_bot.get_userlist", name: "get_userlist", description: "查询可见通讯录" },
      ],
    });
  });

  it("derives a trusted WeCom link only from the authenticated relay result", () => {
    const corpId = "ww-corp";
    const corpIdHash = hashWeComCorpId(corpId);
    const relayIdentity = {
      corpId,
      userId: "ZhangSan",
      relayIssuer: "https://tn1.example.com/wecom",
    };

    expect(deriveTrustedWeComRelayIdentity(relayIdentity, corpId)).toEqual({
      wecomIssuer: relayIdentity.relayIssuer,
      wecomSubject: expect.stringMatching(/^wecom_[A-Za-z0-9_-]{43}$/),
      corpIdHash,
      userIdHash: hashWeComUserId("ZhangSan"),
    });
    expect(() => deriveTrustedWeComRelayIdentity(
      { ...relayIdentity, corpId: "ww-other" },
      corpId,
    )).toThrow("不属于当前配置企业");
    expect(() => deriveTrustedWeComRelayIdentity(
      { ...relayIdentity, relayIssuer: "javascript:alert(1)" },
      corpId,
    )).toThrow("签发方无效");
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

  it("retains only the matched WeCom display fields without exposing raw user IDs", () => {
    expect(parseWeComVisibleUsers({
      errcode: 0,
      userlist: [
        { userid: "ZhangSan", name: " 张三 ", alias: "zhangsan" },
        { userid: "LiSi", name: "" },
      ],
    })).toEqual([
      { userIdHash: hashWeComUserId("ZhangSan"), name: "张三" },
      { userIdHash: hashWeComUserId("LiSi") },
    ]);
  });

  it("builds a readable personal WeCom bot name from the binding employee", () => {
    expect(personalWeComBotDisplayName({
      binderName: "陈英杰",
      connectionName: "usr_2584d27f2876ac74ad508050938826a6fe0152ef",
    })).toBe("陈英杰绑定的企微机器人 · 52ef");
    expect(personalWeComBotDisplayName({
      binderName: "陈英杰",
      connectionName: "usr_2584d27f2876ac74ad508050938826a6fe0152ef",
    })).not.toContain("WeCom Smart Bot");
  });

  it("retries the first WeCom visibility read while QR authorization propagates", async () => {
    const run = vi.fn()
      .mockRejectedValueOnce(new OpenConnectorError("authorization pending", 403))
      .mockRejectedValueOnce(new OpenConnectorError("authorization pending", 409))
      .mockResolvedValue({ errcode: 0, userlist: [{ userid: "ZhangSan" }] });
    const wait = vi.fn().mockResolvedValue(undefined);

    await expect(readWeComBotVisibleUserIdsWithRetry(run, [0, 100, 200], wait)).resolves.toEqual(
      new Set([hashWeComUserId("ZhangSan")]),
    );
    expect(run).toHaveBeenCalledTimes(3);
    expect(wait.mock.calls).toEqual([[100], [200]]);
  });

  it("returns matched WeCom names after visibility propagation", async () => {
    const run = vi.fn()
      .mockRejectedValueOnce(new OpenConnectorError("authorization pending", 403))
      .mockResolvedValue({ errcode: 0, userlist: [{ userid: "ZhangSan", name: "张三" }] });

    await expect(readWeComBotVisibleUsersWithRetry(run, [0, 1], vi.fn().mockResolvedValue(undefined)))
      .resolves.toEqual([{ userIdHash: hashWeComUserId("ZhangSan"), name: "张三" }]);
  });

  it("does not retry a non-transient WeCom visibility failure", async () => {
    const run = vi.fn().mockRejectedValue(new OpenConnectorError("invalid request", 400));
    const wait = vi.fn().mockResolvedValue(undefined);

    await expect(readWeComBotVisibleUserIdsWithRetry(run, [0, 100], wait)).rejects.toThrow("invalid request");
    expect(run).toHaveBeenCalledOnce();
    expect(wait).not.toHaveBeenCalled();
  });

  it("grants only discovered read actions to a QR-created personal WeCom bot", () => {
    const actions = [
      "list_tools",
      "get_userlist",
      "get_message",
      "download_message_media",
      "send_message",
      "delete_todo",
      "call_tool",
    ].map((name) => ({
      id: `wecom_bot.${name}`,
      name,
      requiredScopes: [],
      providerPermissions: [],
    }));

    expect(parseWeComBotPersonalActionIds({
      categories: [{
        category: "contact",
        tools: [{ name: "get_userlist" }],
      }, {
        category: "msg",
        tools: [
          { name: "get_message" },
          { name: "get_msg_media" },
          { name: "send_message" },
        ],
      }, {
        category: "todo",
        tools: [{ name: "delete_todo" }],
      }],
    }, actions)).toEqual([
      "wecom_bot.download_message_media",
      "wecom_bot.get_message",
      "wecom_bot.get_userlist",
      "wecom_bot.list_tools",
    ]);
  });
});
