export type EnterpriseIntegrationPlatform = "feishu" | "wecom" | "wecom_bot" | "dingtalk";

export type EmployeeIntegrationBindingMode = "oauth2" | "unsupported";

export type IntegrationActionOption = {
  id: string;
  name: string;
  description?: string;
  providerPermissions: string[];
};

export type ImportedIntegrationPermissions = {
  tenantScopes: string[];
  userScopes: string[];
  scopes: string[];
};

export type ImportedActionSelection = {
  actionIds: string[];
  matchedScopes: string[];
  unmatchedScopes: string[];
};

function uniqueStrings(values: unknown, field: string) {
  if (values === undefined) return [];
  if (!Array.isArray(values) || values.some((value) => typeof value !== "string")) {
    throw new Error(`${field} 必须是字符串数组`);
  }
  return [...new Set(values.map((value) => value.trim()).filter(Boolean))];
}

export function parseFeishuPermissionExport(input: string): ImportedIntegrationPermissions {
  const normalized = input
    .trim()
    .replace(/^```(?:json)?\s*/i, "")
    .replace(/\s*```$/, "");
  if (!normalized) throw new Error("请粘贴飞书导出的权限 JSON");

  let payload: unknown;
  try {
    payload = JSON.parse(normalized);
  } catch {
    throw new Error("权限 JSON 格式无效");
  }

  if (!payload || typeof payload !== "object" || !("scopes" in payload)) {
    throw new Error("未找到 scopes 权限对象");
  }
  const scopes = payload.scopes;
  if (!scopes || typeof scopes !== "object" || Array.isArray(scopes)) {
    throw new Error("scopes 必须包含 tenant 或 user 权限数组");
  }

  const tenantScopes = uniqueStrings("tenant" in scopes ? scopes.tenant : undefined, "scopes.tenant");
  const userScopes = uniqueStrings("user" in scopes ? scopes.user : undefined, "scopes.user");
  const combinedScopes = [...new Set([...tenantScopes, ...userScopes])];
  if (combinedScopes.length === 0) throw new Error("导出的权限 JSON 中没有可用权限");

  return {
    tenantScopes,
    userScopes,
    scopes: combinedScopes,
  };
}

export function selectActionsForImportedPermissions(
  actions: IntegrationActionOption[],
  importedScopes: string[],
  baseScopes: string[] = [],
): ImportedActionSelection {
  const imported = new Set(importedScopes);
  const actionIds = actions
    .filter((action) => (
      action.providerPermissions.length > 0
      && action.providerPermissions.every((permission) => imported.has(permission))
    ))
    .map((action) => action.id);
  const selectedActionIds = new Set(actionIds);
  const matchedScopes = [...new Set(actions
    .filter((action) => selectedActionIds.has(action.id))
    .flatMap((action) => action.providerPermissions))]
    .filter((scope) => imported.has(scope));
  const recognized = new Set([...matchedScopes, ...baseScopes]);

  return {
    actionIds,
    matchedScopes,
    unmatchedScopes: importedScopes.filter((scope) => !recognized.has(scope)),
  };
}

export function removeActionsRequiringPermission(
  actions: IntegrationActionOption[],
  selectedActionIds: string[],
  permission: string,
) {
  const actionsById = new Map(actions.map((action) => [action.id, action]));
  return selectedActionIds.filter((actionId) => (
    !actionsById.get(actionId)?.providerPermissions.includes(permission)
  ));
}

export type IntegrationApplication = {
  id: string;
  platform: EnterpriseIntegrationPlatform;
  name: string;
  appId: string;
  note: string;
  actionIds: string[];
  active: boolean;
  secretConfigured: true;
  createdAt: string;
  updatedAt: string;
};

export type EnterpriseIntegrationGroup = {
  platform: EnterpriseIntegrationPlatform;
  displayName: string;
  description: string;
  actions: IntegrationActionOption[];
  defaultActionIds: string[];
  oauthBaseScopes: string[];
  applications: IntegrationApplication[];
};

export type EnterpriseIntegrationsSnapshot = {
  groups: EnterpriseIntegrationGroup[];
  updatedAt: string;
};

export type EmployeeConnectorBindingStatus = "pending" | "connected" | "error" | "revoked";

export type EmployeeConnectorBinding = {
  id: string;
  applicationId?: string;
  platform: EnterpriseIntegrationPlatform;
  service: string;
  connectionName: string;
  status: EmployeeConnectorBindingStatus;
  displayName?: string;
  accountId?: string;
  errorMessage?: string;
  connectedAt?: string;
  updatedAt: string;
};

export type EmployeeIntegrationApplication = Pick<
  IntegrationApplication,
  "id" | "platform" | "name" | "appId" | "note" | "active"
> & {
  platformDisplayName: string;
  bindingMode: EmployeeIntegrationBindingMode;
  binding?: EmployeeConnectorBinding;
};

export type EmployeeAvailableConnectionAction = {
  id: string;
  name: string;
  description?: string;
};

export type EmployeeAvailableConnection = {
  id: string;
  service: string;
  serviceDisplayName: string;
  connectionName: string;
  displayName: string;
  accessMode: "account_bound" | "controlled_shared";
  authorizationSources: Array<"personal" | "manual" | "wecom_visibility">;
  actions: EmployeeAvailableConnectionAction[];
};

export type EmployeeIntegrationsSnapshot = {
  identity: {
    name: string;
    email: string;
  };
  wecomIdentity: {
    linked: boolean;
    linkedAt?: string;
  };
  applications: EmployeeIntegrationApplication[];
  availableConnections: EmployeeAvailableConnection[];
  automaticWeComBotCount: number;
  updatedAt: string;
};
