import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import {
  getConnectorProvider,
  listConnectorConnections,
  listConnectorProviders,
  resetOpenConnectorProviderCache,
  saveConnectorConnection,
} from "./open-connector";

const originalUrl = process.env.OPEN_CONNECTOR_URL;
const originalAdminToken = process.env.OPEN_CONNECTOR_ADMIN_TOKEN;

beforeEach(() => {
  process.env.OPEN_CONNECTOR_URL = "http://connector.internal/base";
  process.env.OPEN_CONNECTOR_ADMIN_TOKEN = "admin-secret";
  resetOpenConnectorProviderCache();
});

afterEach(() => {
  if (originalUrl === undefined) delete process.env.OPEN_CONNECTOR_URL;
  else process.env.OPEN_CONNECTOR_URL = originalUrl;
  if (originalAdminToken === undefined) delete process.env.OPEN_CONNECTOR_ADMIN_TOKEN;
  else process.env.OPEN_CONNECTOR_ADMIN_TOKEN = originalAdminToken;
  vi.unstubAllGlobals();
});

describe("OpenConnector provider adapter", () => {
  it("returns compact searchable provider summaries and caches the upstream catalog", async () => {
    const upstream = vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
      void input;
      void init;
      return new Response(JSON.stringify([
        {
          service: "github",
          displayName: "GitHub",
          description: "Developer platform",
          categories: ["Developer Tools"],
          authTypes: ["api_key", "oauth2"],
          iconUrl: "https://example.com/github.svg",
          auth: [{ type: "api_key" }],
          actions: [{ id: "github.issue_get" }, { id: "github.issue_create" }],
        },
        {
          service: "weather",
          displayName: "Weather",
          categories: ["Data"],
          authTypes: ["no_auth"],
          actions: [],
        },
      ]), { status: 200, headers: { "content-type": "application/json" } });
    });
    vi.stubGlobal("fetch", upstream);

    const first = await listConnectorProviders({ query: "git", authType: "oauth2" });
    const second = await listConnectorProviders({ category: "Data" });

    expect(first.items).toEqual([expect.objectContaining({ service: "github", actionCount: 2 })]);
    expect(first.items[0]).not.toHaveProperty("actions");
    expect(second.items).toEqual([expect.objectContaining({ service: "weather" })]);
    expect(upstream).toHaveBeenCalledTimes(1);
    expect(upstream.mock.calls[0][0]).toBe("http://connector.internal/base/api/providers");
    expect((upstream.mock.calls[0][1]?.headers as Record<string, string>).Authorization).toBe("Bearer admin-secret");
  });

  it("normalizes dynamic API key, custom credential, and OAuth fields", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => new Response(JSON.stringify({
      service: "example",
      displayName: "Example",
      categories: ["Developer Tools"],
      authTypes: ["api_key", "custom_credential", "oauth2"],
      actions: [{
        id: "example.read",
        name: "read",
        description: "Read an example",
        requiredScopes: ["read"],
        inputSchema: { type: "object", properties: { id: { type: "string" } } },
        outputSchema: { type: "object" },
        execution: { locallyExecutable: true, requiredAuthTypes: ["api_key"], needsCredential: true },
      }],
      auth: [
        { type: "api_key", label: "Token", extraFields: [{ key: "tenant", label: "Tenant", inputType: "text", required: true, secret: false }] },
        { type: "custom_credential", fields: [{ key: "json", label: "JSON", inputType: "json", required: true, secret: true }] },
        { type: "oauth2", scopes: ["read"], clientConfigFields: [{ key: "region", label: "Region", inputType: "text", required: true, secret: false, location: "extra" }] },
      ],
    }), { status: 200, headers: { "content-type": "application/json" } })));

    const provider = await getConnectorProvider("example");

    expect(provider.actionCount).toBe(1);
    expect(provider.auth).toEqual([
      expect.objectContaining({ type: "api_key", label: "Token", extraFields: [expect.objectContaining({ key: "tenant" })] }),
      expect.objectContaining({ type: "custom_credential", fields: [expect.objectContaining({ inputType: "json" })] }),
      expect.objectContaining({ type: "oauth2", scopes: ["read"], clientConfigFields: [expect.objectContaining({ location: "extra" })] }),
    ]);
    expect(provider.actions).toEqual([
      expect.objectContaining({
        id: "example.read",
        name: "read",
        requiredScopes: ["read"],
        inputSchema: expect.objectContaining({ type: "object" }),
        execution: expect.objectContaining({ locallyExecutable: true, requiredAuthTypes: ["api_key"], needsCredential: true }),
      }),
    ]);
  });
});

describe("OpenConnector connection adapter", () => {
  it("returns safe connection summaries", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => new Response(JSON.stringify([{
      id: "github:default",
      service: "github",
      connectionName: "default",
      authType: "api_key",
      configured: true,
      virtual: false,
      default: true,
      profile: { accountId: "42", displayName: "Acme", grantedScopes: ["repo"] },
      apiKey: "must-not-leak",
    }]), { status: 200, headers: { "content-type": "application/json" } })));

    const snapshot = await listConnectorConnections();

    expect(snapshot.connections[0]).toEqual({
      id: "github:default",
      service: "github",
      connectionName: "default",
      authType: "api_key",
      accessMode: "global",
      configured: true,
      virtual: false,
      default: true,
      profile: { accountId: "42", displayName: "Acme", grantedScopes: ["repo"] },
    });
    expect(snapshot.connections[0]).not.toHaveProperty("apiKey");
  });

  it("sends credentials only in the server-side Admin request", async () => {
    const upstream = vi.fn(async (_input: string | URL | Request, init?: RequestInit) => {
      const body = JSON.parse(String(init?.body));
      return new Response(JSON.stringify({
        id: "github:default",
        service: "github",
        connectionName: body.connectionName,
        authType: body.authType,
        configured: true,
        virtual: false,
        default: true,
        profile: { accountId: "github:42", displayName: "Acme", grantedScopes: [] },
      }), { status: 200, headers: { "content-type": "application/json" } });
    });
    vi.stubGlobal("fetch", upstream);

    await saveConnectorConnection("github", {
      connectionName: "default",
      authType: "api_key",
      values: { apiKey: "provider-secret" },
    });

    expect(upstream.mock.calls[0][0]).toBe("http://connector.internal/base/api/connections/github");
    expect(upstream.mock.calls[0][1]).toEqual(expect.objectContaining({
      method: "PUT",
      headers: expect.objectContaining({ Authorization: "Bearer admin-secret" }),
    }));
    expect(JSON.parse(String(upstream.mock.calls[0][1]?.body))).toEqual({
      connectionName: "default",
      authType: "api_key",
      values: { apiKey: "provider-secret" },
    });
  });
});
