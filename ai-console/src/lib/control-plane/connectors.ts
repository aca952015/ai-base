export type ConnectorAuthType = "no_auth" | "api_key" | "custom_credential" | "oauth2";
export type ConnectorAccessMode = "no_auth" | "account_bound" | "controlled_shared" | "global";

export type ConnectorCredentialField = {
  key: string;
  label: string;
  inputType: "text" | "password" | "textarea" | "json";
  required: boolean;
  secret: boolean;
  placeholder?: string;
  description?: string;
};
export type ConnectorOAuthClientField = ConnectorCredentialField & {
  location?: "extra" | "secretExtra";
  defaultValue?: string;
};

export type ConnectorAuthDefinition =
  | { type: "no_auth" }
  | {
      type: "api_key";
      label?: string;
      placeholder?: string;
      description?: string;
      extraFields: ConnectorCredentialField[];
    }
  | {
      type: "custom_credential";
      fields: ConnectorCredentialField[];
    }
  | {
      type: "oauth2";
      scopes: string[];
      clientConfigFields: ConnectorOAuthClientField[];
    };

export type ConnectorProviderSummary = {
  service: string;
  displayName: string;
  description?: string;
  categories: string[];
  authTypes: ConnectorAuthType[];
  iconUrl?: string;
  actionCount: number;
};

export type ConnectorActionDefinition = {
  id: string;
  name: string;
  description?: string;
  requiredScopes: string[];
  providerPermissions: string[];
  inputSchema?: Record<string, unknown>;
  outputSchema?: Record<string, unknown>;
  execution?: {
    locallyExecutable: boolean;
    catalogOnly: boolean;
    requiredAuthTypes: ConnectorAuthType[];
    noAuthRunnable: boolean;
    needsCredential: boolean;
  };
};

export type ConnectorProviderDetail = ConnectorProviderSummary & {
  auth: ConnectorAuthDefinition[];
  actions: ConnectorActionDefinition[];
};

export type ConnectorProvidersPage = {
  items: ConnectorProviderSummary[];
  total: number;
  page: number;
  limit: number;
  categories: string[];
  authTypes: ConnectorAuthType[];
};

export type ConnectorLocalAccount = {
  name: string;
  email: string;
};

export type ConnectorSharedAccess = {
  resourceId: string;
  displayName: string;
  securityDomain: string;
  authorizationMode: "manual" | "wecom_visibility";
  actionCount: number;
  enabled: boolean;
  grantCount: number;
};

export type ConnectorConnection = {
  id: string;
  service: string;
  connectionName: string;
  authType: ConnectorAuthType;
  accessMode: ConnectorAccessMode;
  configured: boolean;
  virtual: boolean;
  default: boolean;
  profile: {
    accountId: string;
    displayName: string;
    grantedScopes: string[];
  };
  localAccount?: ConnectorLocalAccount;
  sharedAccess?: ConnectorSharedAccess;
};

export type ConnectorConnectionsSnapshot = {
  connections: ConnectorConnection[];
  updatedAt: string;
};

export type ConnectorConnectionInput = {
  connectionName: string;
  authType: ConnectorAuthType;
  values: Record<string, string>;
};

export type ConnectorOAuthConfig = {
  service: string;
  configured: boolean;
  clientId: string | null;
  expectedRedirectUri: string;
};

export type ConnectorOAuthConfigInput = {
  clientId: string;
  clientSecret: string;
  extra: Record<string, string>;
  secretExtra: Record<string, string>;
};

export type ConnectorOAuthAuthorization = {
  service: string;
  authorizationUrl: string;
};

export function connectorActionIsAuthorized(
  connection: ConnectorConnection,
  action: ConnectorActionDefinition,
) {
  if (connection.authType !== "oauth2") return true;
  const grantedScopes = new Set(connection.profile.grantedScopes);
  return action.providerPermissions.every((permission) => grantedScopes.has(permission));
}

export function connectorConnectionKey(service: string, connectionName: string) {
  return `${service}\0${connectionName}`;
}

export function classifyConnectorConnections(
  connections: ConnectorConnection[],
  localAccountsByConnectionKey: ReadonlyMap<string, ConnectorLocalAccount>,
  sharedAccessByConnectionKey: ReadonlyMap<string, ConnectorSharedAccess> = new Map(),
) {
  return connections.map((connection) => {
    const key = connectorConnectionKey(connection.service, connection.connectionName);
    const localAccount = localAccountsByConnectionKey.get(key);
    const sharedAccess = sharedAccessByConnectionKey.get(key);
    if (connection.authType === "no_auth") {
      return { ...connection, accessMode: "no_auth" as const, localAccount: undefined, sharedAccess: undefined };
    }
    if (localAccount) {
      return { ...connection, accessMode: "account_bound" as const, localAccount, sharedAccess: undefined };
    }
    if (sharedAccess) {
      return { ...connection, accessMode: "controlled_shared" as const, localAccount: undefined, sharedAccess };
    }
    return { ...connection, accessMode: "global" as const, localAccount: undefined, sharedAccess: undefined };
  });
}

export const connectorAuthLabels: Record<ConnectorAuthType, string> = {
  no_auth: "无需认证",
  api_key: "API Key",
  custom_credential: "自定义凭据",
  oauth2: "OAuth 2.0",
};
