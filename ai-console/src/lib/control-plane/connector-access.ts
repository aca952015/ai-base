export type SharedConnectorPrincipalType = "user" | "group";

export type SharedConnectorGrant = {
  id: string;
  principalType: SharedConnectorPrincipalType;
  principalIssuer: string;
  principalSubject: string | null;
  principalEmail: string | null;
  groupName: string | null;
  actionIds: string[];
  startsAt: string | null;
  expiresAt: string | null;
  enabled: boolean;
};

export type SharedConnectorResource = {
  id: string;
  service: string;
  connectionName: string;
  displayName: string;
  securityDomain: string;
  enabled: boolean;
  grants: SharedConnectorGrant[];
  updatedAt: string;
};

export type SharedConnectorAccessSnapshot = {
  resources: SharedConnectorResource[];
  hardDeniedActionIds: string[];
  updatedAt: string;
};

export type SharedConnectorGrantInput = {
  principalType: SharedConnectorPrincipalType;
  principalSubject?: string;
  principalEmail?: string;
  groupName?: string;
  actionIds: string[];
  startsAt?: string;
  expiresAt?: string;
  enabled?: boolean;
};

export type SharedConnectorResourceInput = {
  service: string;
  connectionName: string;
  displayName: string;
  securityDomain?: string;
  enabled?: boolean;
  grants: SharedConnectorGrantInput[];
};
