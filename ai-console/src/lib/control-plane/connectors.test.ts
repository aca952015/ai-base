import { describe, expect, it } from "vitest";

import {
  classifyConnectorConnections,
  connectorActionIsAuthorized,
  type ConnectorActionDefinition,
  type ConnectorConnection,
} from "./connectors";

const oauthConnection: ConnectorConnection = {
  id: "feishu/default",
  service: "feishu",
  connectionName: "default",
  authType: "oauth2",
  accessMode: "global",
  configured: true,
  virtual: false,
  default: true,
  profile: {
    accountId: "employee",
    displayName: "Employee",
    grantedScopes: ["offline_access", "base:app:read", "base:record:read"],
  },
};

function action(providerPermissions: string[]): ConnectorActionDefinition {
  return {
    id: "feishu.example",
    name: "example",
    requiredScopes: [],
    providerPermissions,
  };
}

describe("connector action authorization", () => {
  it("includes OAuth actions only when every provider permission was granted", () => {
    expect(connectorActionIsAuthorized(
      oauthConnection,
      action(["base:app:read", "base:record:read"]),
    )).toBe(true);
    expect(connectorActionIsAuthorized(
      oauthConnection,
      action(["base:app:read", "base:record:write"]),
    )).toBe(false);
  });

  it("includes OAuth actions that do not declare provider permissions", () => {
    expect(connectorActionIsAuthorized(oauthConnection, action([]))).toBe(true);
  });

  it("treats credential and no-auth actions as authorized", () => {
    for (const authType of ["api_key", "custom_credential", "no_auth"] as const) {
      expect(connectorActionIsAuthorized(
        { ...oauthConnection, authType },
        action(["scope:not-reported-by-credential-connections"]),
      )).toBe(true);
    }
  });
});

describe("connector access classification", () => {
  it("separates no-auth, employee-bound, and global connections", () => {
    const connections: ConnectorConnection[] = [
      {
        ...oauthConnection,
        id: "linuxdo/default",
        service: "linuxdo",
        connectionName: "default",
        authType: "no_auth",
        accessMode: "global",
      },
      {
        ...oauthConnection,
        id: "feishu/usr_employee",
        connectionName: "usr_employee",
      },
      oauthConnection,
    ];

    const classified = classifyConnectorConnections(
      connections,
      new Map([["feishu\0usr_employee", {
        name: "张三",
        email: "zhangsan@example.com",
      }]]),
    );

    expect(classified.map((connection) => connection.accessMode)).toEqual([
      "no_auth",
      "account_bound",
      "global",
    ]);
    expect(classified[1].localAccount).toEqual({
      name: "张三",
      email: "zhangsan@example.com",
    });
    expect(classified[0].localAccount).toBeUndefined();
    expect(classified[2].localAccount).toBeUndefined();
  });
});
