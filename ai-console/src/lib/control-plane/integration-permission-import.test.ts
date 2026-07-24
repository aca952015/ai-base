import { describe, expect, it } from "vitest";

import {
  parseFeishuPermissionExport,
  removeActionsRequiringPermission,
  selectActionsForImportedPermissions,
  type IntegrationActionOption,
} from "./integrations";

const actions: IntegrationActionOption[] = [
  {
    id: "feishu.list_records",
    name: "List records",
    providerPermissions: ["base:record:read"],
  },
  {
    id: "feishu.copy_base",
    name: "Copy base",
    providerPermissions: ["base:app:read", "base:app:copy"],
  },
  {
    id: "feishu.no_scope",
    name: "No scope",
    providerPermissions: [],
  },
];

describe("Feishu permission JSON import", () => {
  it("parses tenant and user scopes from the Feishu export shape", () => {
    expect(parseFeishuPermissionExport(`{
      "scopes": {
        "tenant": ["base:record:read", "base:record:read"],
        "user": ["contact:user:read"]
      }
    }`)).toEqual({
      tenantScopes: ["base:record:read"],
      userScopes: ["contact:user:read"],
      scopes: ["base:record:read", "contact:user:read"],
    });
  });

  it("accepts JSON copied inside a markdown code fence", () => {
    expect(parseFeishuPermissionExport("```json\n{\"scopes\":{\"tenant\":[\"base:record:read\"],\"user\":[]}}\n```").scopes)
      .toEqual(["base:record:read"]);
  });

  it("selects only actions fully covered by imported permissions", () => {
    expect(selectActionsForImportedPermissions(actions, ["base:record:read", "base:app:read", "unmapped"], ["offline_access"]))
      .toEqual({
        actionIds: ["feishu.list_records"],
        matchedScopes: ["base:record:read"],
        unmatchedScopes: ["base:app:read", "unmapped"],
      });
  });

  it("rejects malformed export data", () => {
    expect(() => parseFeishuPermissionExport("{")).toThrow("权限 JSON 格式无效");
    expect(() => parseFeishuPermissionExport("{}")).toThrow("未找到 scopes 权限对象");
  });

  it("removes every selected action that requires a removed permission", () => {
    expect(removeActionsRequiringPermission(
      actions,
      ["feishu.list_records", "feishu.copy_base", "feishu.no_scope"],
      "base:app:read",
    )).toEqual(["feishu.list_records", "feishu.no_scope"]);
  });
});
