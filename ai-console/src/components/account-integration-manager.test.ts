import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";

import type { EmployeeIntegrationsSnapshot } from "@/lib/control-plane/integrations";

import {
  AccountConnectionActionList,
  WeComIdentityCard,
  connectionAccessLabel,
  connectionDetailPresentation,
  connectionsForIntegration,
  isDisconnectablePersonalWeComBot,
  wecomOrganizationBindingPresentation,
  wecomOrganizationIntegrationId,
  wecomLinkResultMessage,
} from "./account-integration-manager";

describe("WeCom account result messages", () => {
  it("does not show an ambiguous message after automatic login", () => {
    expect(wecomLinkResultMessage("restored")).toBeUndefined();
  });

  it("keeps actionable first-link and error messages", () => {
    expect(wecomLinkResultMessage("linked")?.text).toContain("已与当前平台账号绑定");
    expect(wecomLinkResultMessage("expired")?.tone).toBe("error");
  });
});

describe("WeCom identity card", () => {
  it("does not allow binding before a trusted WeCom identity is received", () => {
    const html = renderToStaticMarkup(createElement(WeComIdentityCard, {
      organization: {
        id: "22222222-2222-4222-8222-222222222222",
        organizationName: "示例组织",
        active: true,
        configured: true,
      },
      availableConnectionCount: 0,
      onOpen: () => undefined,
    }));

    expect(html).toContain("示例组织");
    expect(html).toContain("尚未绑定此组织身份");
    expect(html).toContain("请从“示例组织”企业微信应用首页进入后认证");
    expect(html).toContain("查看示例组织的账号绑定与可用权限");
    expect(html).toContain("disabled");
    expect(html).not.toContain('href="/auth/wework"');
  });

  it("keeps each configured organization as an independent binding relationship", () => {
    expect(wecomOrganizationBindingPresentation({ active: true, configured: true }, true).label).toBe("已绑定");
    expect(wecomOrganizationBindingPresentation({ active: true, configured: true }, false).label).toBe("未绑定");
    expect(wecomOrganizationBindingPresentation({ active: false, configured: false }, true).label).toBe("已停用");
  });
});

describe("integration permission details", () => {
  const snapshot: EmployeeIntegrationsSnapshot = {
    identity: { name: "employee01", email: "employee01@example.com" },
    wecomIdentity: {
      linked: true,
      identities: [{
        id: "11111111-1111-4111-8111-111111111111",
        organizationId: "22222222-2222-4222-8222-222222222222",
        organizationName: "示例组织",
        linkedAt: "2026-08-18T00:00:00.000Z",
      }, {
        id: "33333333-3333-4333-8333-333333333333",
        organizationId: "44444444-4444-4444-8444-444444444444",
        organizationName: "第二组织",
        linkedAt: "2026-08-18T01:00:00.000Z",
      }],
    },
    wecomOrganizations: [{
      id: "22222222-2222-4222-8222-222222222222",
      organizationName: "示例组织",
      active: true,
      configured: true,
    }, {
      id: "44444444-4444-4444-8444-444444444444",
      organizationName: "第二组织",
      active: true,
      configured: true,
    }],
    applications: [{
      id: "feishu-app",
      platform: "feishu",
      name: "WorkBuddy",
      appId: "app-id",
      note: "",
      active: true,
      platformDisplayName: "飞书",
      bindingMode: "oauth2",
      binding: {
        id: "binding-id",
        applicationId: "feishu-app",
        platform: "feishu",
        service: "feishu",
        connectionName: "usr_employee",
        status: "connected",
        updatedAt: "2026-08-18T00:00:00.000Z",
      },
    }],
    availableConnections: [{
      id: "feishu:usr_employee",
      service: "feishu",
      serviceDisplayName: "飞书",
      connectionName: "usr_employee",
      displayName: "employee01",
      accessMode: "account_bound",
      authorizationSources: ["personal"],
      actions: [{ id: "feishu.get_document", name: "get_document", description: "读取文档" }],
    }, {
      id: "wecom_bot:personal",
      service: "wecom_bot",
      serviceDisplayName: "企业微信机器人",
      connectionName: "personal",
      displayName: "个人机器人",
      accessMode: "account_bound",
      authorizationSources: ["personal"],
      actions: [{ id: "wecom_bot.get_userlist", name: "get_userlist" }],
    }, {
      id: "wecom_bot:sales",
      service: "wecom_bot",
      serviceDisplayName: "企业微信机器人",
      connectionName: "sales",
      displayName: "销售机器人",
      accessMode: "controlled_shared",
      authorizationSources: ["wecom_visibility"],
      wecomOrganizationIds: ["22222222-2222-4222-8222-222222222222"],
      actions: [{ id: "wecom_bot.get_userlist", name: "get_userlist" }],
    }, {
      id: "wecom_bot:support",
      service: "wecom_bot",
      serviceDisplayName: "企业微信机器人",
      connectionName: "support",
      displayName: "客服机器人",
      accessMode: "controlled_shared",
      authorizationSources: ["wecom_visibility"],
      wecomOrganizationIds: ["44444444-4444-4444-8444-444444444444"],
      actions: [{ id: "wecom_bot.get_message", name: "get_message" }],
    }],
    automaticWeComBotCount: 2,
    updatedAt: "2026-08-18T00:00:00.000Z",
  };

  it("groups WeCom connections under their exact organization binding", () => {
    expect(connectionsForIntegration(
      snapshot,
      wecomOrganizationIntegrationId("22222222-2222-4222-8222-222222222222"),
    ).map((connection) => connection.id)).toEqual([
      "wecom_bot:personal",
      "wecom_bot:sales",
    ]);
    expect(connectionsForIntegration(
      snapshot,
      wecomOrganizationIntegrationId("44444444-4444-4444-8444-444444444444"),
    ).map((connection) => connection.id)).toEqual([
      "wecom_bot:personal",
      "wecom_bot:support",
    ]);
  });

  it("labels multiple WeCom bots with an ordinal while preserving their unique names", () => {
    const integrationId = wecomOrganizationIntegrationId("22222222-2222-4222-8222-222222222222");
    const connections = connectionsForIntegration(snapshot, integrationId);

    expect(connectionDetailPresentation(connections[0], 0, connections.length, integrationId)).toEqual({
      eyebrow: "企业微信机器人 1/2",
      title: "个人机器人",
    });
    expect(connectionDetailPresentation(connections[1], 1, connections.length, integrationId)).toEqual({
      eyebrow: "企业微信机器人 2/2",
      title: "销售机器人",
    });
    expect(connections.map((connection) => connection.connectionName)).toEqual(["personal", "sales"]);
  });

  it("keeps WeCom bot actions collapsed by default", () => {
    const connection = connectionsForIntegration(
      snapshot,
      wecomOrganizationIntegrationId("22222222-2222-4222-8222-222222222222"),
    )[0];
    const html = renderToStaticMarkup(createElement(AccountConnectionActionList, {
      connection,
      collapsible: true,
    }));

    expect(html).toContain('<details class="account-connection-actions">');
    expect(html).not.toContain("<details open");
    expect(html).toContain("Action 授权");
    expect(html).toContain("1 个");
    expect(html).toContain("wecom_bot.get_userlist");
  });

  it("groups a personal connection under its exact application card", () => {
    expect(connectionsForIntegration(snapshot, "feishu-app").map((connection) => connection.id)).toEqual([
      "feishu:usr_employee",
    ]);
  });

  it("distinguishes WeCom visibility grants from ordinary shared grants", () => {
    expect(connectionAccessLabel(snapshot.availableConnections[2])).toBe("企微可见范围");
  });

  it("allows unlinking only personal WeCom bot connections", () => {
    expect(isDisconnectablePersonalWeComBot(snapshot.availableConnections[1])).toBe(true);
    expect(isDisconnectablePersonalWeComBot(snapshot.availableConnections[2])).toBe(false);
    expect(isDisconnectablePersonalWeComBot(snapshot.availableConnections[0])).toBe(false);
  });
});
