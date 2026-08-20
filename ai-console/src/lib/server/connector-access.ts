import { randomUUID } from "node:crypto";

import type { PoolClient, QueryResultRow } from "pg";

import type {
  SharedConnectorAccessSnapshot,
  SharedConnectorGrant,
  SharedConnectorGrantInput,
  SharedConnectorAuthorizationMode,
  SharedConnectorResource,
  SharedConnectorResourceInput,
} from "../control-plane/connector-access";
import type { ConsoleIdentity } from "./console-identity";
import { ensureSchema, getPool, IntegrationStoreError } from "./integrations";
import { getConnectorProvider, listConnectorConnections } from "./open-connector";

const SERVICE_PATTERN = /^[a-z0-9][a-z0-9_-]{0,127}$/;
const CONNECTION_PATTERN = /^[a-zA-Z0-9][a-zA-Z0-9_-]{0,127}$/;
const ACTION_PATTERN = /^[a-z0-9][a-z0-9_-]{0,127}\.[a-zA-Z0-9][a-zA-Z0-9_.-]{0,255}$/;
const MAX_GRANTS = 500;
const MAX_ACTIONS = 1_000;

export const hardDeniedConnectorActionIds = [
  "wecom_bot.call_tool",
  "wecom_bot.send_text_message",
  "wecom_bot.send_markdown_message",
  "wecom_bot.send_markdown_v2_message",
  "wecom_bot.send_image_message",
  "wecom_bot.send_news_message",
] as const;

const hardDeniedActionSet = new Set<string>(hardDeniedConnectorActionIds);

type SharedResourceRow = QueryResultRow & {
  id: string;
  service: string;
  connection_name: string;
  display_name: string;
  security_domain: string;
  authorization_mode: SharedConnectorAuthorizationMode;
  wecom_organization_id: string | null;
  wecom_organization_name: string | null;
  action_ids: unknown;
  enabled: boolean;
  updated_at: Date | string;
};

type SharedGrantRow = QueryResultRow & {
  id: string;
  resource_id: string;
  principal_type: "user" | "group";
  principal_issuer: string;
  principal_subject: string | null;
  principal_email: string | null;
  group_name: string | null;
  action_ids: unknown;
  starts_at: Date | string | null;
  expires_at: Date | string | null;
  enabled: boolean;
};

function requiredText(value: unknown, label: string, maxLength: number) {
  if (typeof value !== "string" || !value.trim()) {
    throw new IntegrationStoreError(`${label}不能为空`, 400);
  }
  const normalized = value.trim();
  if (normalized.length > maxLength) throw new IntegrationStoreError(`${label}不能超过 ${maxLength} 个字符`, 400);
  return normalized;
}

function optionalTimestamp(value: unknown, label: string) {
  if (value === undefined || value === null || value === "") return null;
  if (typeof value !== "string") throw new IntegrationStoreError(`${label}格式无效`, 400);
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) throw new IntegrationStoreError(`${label}格式无效`, 400);
  return date.toISOString();
}

function stringArray(value: unknown) {
  if (!Array.isArray(value)) return [];
  return value
    .filter((item): item is string => typeof item === "string" && Boolean(item.trim()))
    .map((item) => item.trim());
}

function serializeGrant(row: SharedGrantRow): SharedConnectorGrant {
  return {
    id: row.id,
    principalType: row.principal_type,
    principalIssuer: row.principal_issuer,
    principalSubject: row.principal_subject,
    principalEmail: row.principal_email,
    groupName: row.group_name,
    actionIds: stringArray(row.action_ids),
    startsAt: row.starts_at ? new Date(row.starts_at).toISOString() : null,
    expiresAt: row.expires_at ? new Date(row.expires_at).toISOString() : null,
    enabled: row.enabled,
  };
}

function serializeResource(row: SharedResourceRow, grants: SharedConnectorGrant[]): SharedConnectorResource {
  return {
    id: row.id,
    service: row.service,
    connectionName: row.connection_name,
    displayName: row.display_name,
    securityDomain: row.security_domain,
    authorizationMode: row.authorization_mode,
    wecomOrganizationId: row.wecom_organization_id,
    wecomOrganizationName: row.wecom_organization_name,
    actionIds: stringArray(row.action_ids),
    enabled: row.enabled,
    grants,
    updatedAt: new Date(row.updated_at).toISOString(),
  };
}

async function readResources(): Promise<SharedConnectorResource[]> {
  const [resources, grants] = await Promise.all([
    getPool().query<SharedResourceRow>(`
      SELECT resource.id, resource.service, resource.connection_name, resource.display_name,
             resource.security_domain, resource.authorization_mode,
             resource.wecom_organization_id,
             organization.organization_name AS wecom_organization_name,
             resource.action_ids, resource.enabled, resource.updated_at
      FROM shared_connector_resources AS resource
      LEFT JOIN wecom_authentication_organizations AS organization
        ON organization.id = resource.wecom_organization_id
      ORDER BY resource.service, resource.connection_name
    `),
    getPool().query<SharedGrantRow>(`
      SELECT id, resource_id, principal_type, principal_issuer, principal_subject,
             principal_email, group_name, action_ids, starts_at, expires_at, enabled
      FROM shared_connector_grants
      ORDER BY created_at, id
    `),
  ]);
  const grantsByResource = new Map<string, SharedConnectorGrant[]>();
  for (const row of grants.rows) {
    const current = grantsByResource.get(row.resource_id) || [];
    current.push(serializeGrant(row));
    grantsByResource.set(row.resource_id, current);
  }
  return resources.rows.map((row) => serializeResource(row, grantsByResource.get(row.id) || []));
}

export async function getSharedConnectorAccess(): Promise<SharedConnectorAccessSnapshot> {
  await ensureSchema();
  const organizations = await getPool().query<{
    id: string;
    organization_name: string;
    corp_id: string;
    relay_callback_url: string | null;
    active: boolean;
  }>(`
    SELECT id, organization_name, corp_id, relay_callback_url, active
    FROM wecom_authentication_organizations
    ORDER BY organization_name, id
  `);
  return {
    resources: await readResources(),
    wecomOrganizations: organizations.rows.map((organization) => ({
      id: organization.id,
      name: organization.organization_name,
      configured: Boolean(
        organization.active && organization.corp_id
        && organization.relay_callback_url
      ),
    })),
    hardDeniedActionIds: [...hardDeniedConnectorActionIds],
    updatedAt: new Date().toISOString(),
  };
}

async function validateConnection(service: string, connectionName: string) {
  if (!SERVICE_PATTERN.test(service)) throw new IntegrationStoreError("Connector Service ID 无效", 400);
  if (!CONNECTION_PATTERN.test(connectionName) || connectionName.toLowerCase() === "default") {
    throw new IntegrationStoreError("受控共享必须引用非 default 的具名连接", 400);
  }
  const snapshot = await listConnectorConnections();
  const connection = snapshot.connections.find((candidate) => (
    candidate.service === service
    && candidate.connectionName === connectionName
    && candidate.configured
    && candidate.authType !== "no_auth"
  ));
  if (!connection) throw new IntegrationStoreError("OpenConnector 中不存在可用的具名连接", 409);
  const personalBinding = await getPool().query(`
    SELECT 1
    FROM employee_connector_bindings
    WHERE service = $1 AND connection_name = $2 AND status <> 'revoked'
    LIMIT 1
  `, [service, connectionName]);
  if (personalBinding.rowCount) {
    throw new IntegrationStoreError("员工个人连接不能转换为受控共享连接", 409);
  }
  return connection;
}

async function normalizeGrants(
  identity: ConsoleIdentity,
  service: string,
  grants: SharedConnectorGrantInput[],
) {
  if (!Array.isArray(grants) || grants.length > MAX_GRANTS) {
    throw new IntegrationStoreError(`授权规则不能超过 ${MAX_GRANTS} 条`, 400);
  }
  const provider = await getConnectorProvider(service);
  const knownActions = new Set(provider.actions.map((action) => action.id));
  return grants.map((grant, index) => {
    if (!grant || typeof grant !== "object") throw new IntegrationStoreError(`第 ${index + 1} 条授权无效`, 400);
    if (grant.principalType !== "user" && grant.principalType !== "group") {
      throw new IntegrationStoreError(`第 ${index + 1} 条授权对象类型无效`, 400);
    }
    const actionIds = Array.from(new Set(stringArray(grant.actionIds)));
    if (!actionIds.length) throw new IntegrationStoreError(`第 ${index + 1} 条授权至少选择一个 Action`, 400);
    if (actionIds.length > MAX_ACTIONS) throw new IntegrationStoreError(`Action 不能超过 ${MAX_ACTIONS} 个`, 400);
    for (const actionId of actionIds) {
      if (!ACTION_PATTERN.test(actionId) || !knownActions.has(actionId)) {
        throw new IntegrationStoreError(`Action ${actionId} 不存在`, 400);
      }
      if (hardDeniedActionSet.has(actionId)) {
        throw new IntegrationStoreError(`Action ${actionId} 属于系统禁止项`, 409);
      }
    }
    const startsAt = optionalTimestamp(grant.startsAt, "授权开始时间");
    const expiresAt = optionalTimestamp(grant.expiresAt, "授权结束时间");
    if (startsAt && expiresAt && new Date(startsAt) >= new Date(expiresAt)) {
      throw new IntegrationStoreError("授权结束时间必须晚于开始时间", 400);
    }
    const principalSubject = grant.principalType === "user" && grant.principalSubject
      ? requiredText(grant.principalSubject, "员工 Subject", 512)
      : null;
    const principalEmail = grant.principalType === "user" && grant.principalEmail
      ? requiredText(grant.principalEmail, "员工邮箱", 320).toLowerCase()
      : null;
    const groupName = grant.principalType === "group"
      ? requiredText(grant.groupName, "群组名称", 255).toLowerCase()
      : null;
    if (grant.principalType === "user" && !principalSubject && !principalEmail) {
      throw new IntegrationStoreError("员工授权必须填写邮箱或 Subject", 400);
    }
    return {
      id: randomUUID(),
      principalType: grant.principalType,
      principalIssuer: identity.principalIssuer,
      principalSubject,
      principalEmail,
      groupName,
      actionIds,
      startsAt,
      expiresAt,
      enabled: grant.enabled !== false,
    };
  });
}

export async function validateSharedConnectorActionIds(service: string, value: unknown) {
  const actionIds = Array.from(new Set(stringArray(value)));
  if (!actionIds.length) throw new IntegrationStoreError("企微机器人至少选择一个可用 Action", 400);
  if (actionIds.length > MAX_ACTIONS) throw new IntegrationStoreError(`Action 不能超过 ${MAX_ACTIONS} 个`, 400);
  const provider = await getConnectorProvider(service);
  const knownActions = new Set(provider.actions.map((action) => action.id));
  for (const actionId of actionIds) {
    if (!ACTION_PATTERN.test(actionId) || !knownActions.has(actionId)) {
      throw new IntegrationStoreError(`Action ${actionId} 不存在`, 400);
    }
    if (hardDeniedActionSet.has(actionId)) {
      throw new IntegrationStoreError(`Action ${actionId} 属于系统禁止项`, 409);
    }
  }
  return actionIds;
}

async function replaceGrants(
  client: PoolClient,
  resourceId: string,
  actor: string,
  grants: Awaited<ReturnType<typeof normalizeGrants>>,
) {
  await client.query("DELETE FROM shared_connector_grants WHERE resource_id = $1", [resourceId]);
  for (const grant of grants) {
    await client.query(`
      INSERT INTO shared_connector_grants (
        id, resource_id, principal_type, principal_issuer, principal_subject,
        principal_email, group_name, action_ids, starts_at, expires_at,
        enabled, created_by, updated_by
      ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8::JSONB, $9, $10, $11, $12, $12)
    `, [
      grant.id,
      resourceId,
      grant.principalType,
      grant.principalIssuer,
      grant.principalSubject,
      grant.principalEmail,
      grant.groupName,
      JSON.stringify(grant.actionIds),
      grant.startsAt,
      grant.expiresAt,
      grant.enabled,
      actor,
    ]);
  }
}

export async function saveSharedConnectorResource(
  identity: ConsoleIdentity,
  input: SharedConnectorResourceInput,
) {
  await ensureSchema();
  const service = requiredText(input.service, "Connector Service ID", 128);
  const connectionName = requiredText(input.connectionName, "连接名称", 128);
  const connection = await validateConnection(service, connectionName);
  const displayName = input.displayName
    ? requiredText(input.displayName, "显示名称", 120)
    : connection.profile.displayName;
  const securityDomain = input.securityDomain
    ? requiredText(input.securityDomain, "安全域", 64).toLowerCase()
    : "general";
  const authorizationMode = input.authorizationMode === "wecom_visibility"
    ? "wecom_visibility"
    : "manual";
  if (service === "wecom_bot" && authorizationMode !== "wecom_visibility") {
    throw new IntegrationStoreError("企微机器人必须使用企业身份可见范围筛选", 409);
  }
  if (service !== "wecom_bot" && authorizationMode !== "manual") {
    throw new IntegrationStoreError("当前 Connector 不支持企微可见范围筛选", 409);
  }
  let wecomOrganizationId: string | null = null;
  if (authorizationMode === "wecom_visibility") {
    wecomOrganizationId = requiredText(input.wecomOrganizationId, "企业微信组织", 64);
    const organization = await getPool().query(`
      SELECT 1 FROM wecom_authentication_organizations
      WHERE id = $1 AND active AND corp_id <> ''
        AND relay_callback_url IS NOT NULL
    `, [wecomOrganizationId]);
    if (!organization.rowCount) throw new IntegrationStoreError("企业微信认证组织不存在、未完成配置或已停用", 409);
  }
  const actionIds = authorizationMode === "wecom_visibility"
    ? await validateSharedConnectorActionIds(service, input.actionIds)
    : [];
  const grants = authorizationMode === "manual"
    ? await normalizeGrants(identity, service, input.grants || [])
    : [];
  const actor = identity.email;
  const id = randomUUID();
  const client = await getPool().connect();
  try {
    await client.query("BEGIN");
    const result = await client.query<{ id: string }>(`
      INSERT INTO shared_connector_resources (
        id, service, connection_name, display_name, security_domain,
        authorization_mode, wecom_organization_id, action_ids, enabled, created_by, updated_by
      ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8::JSONB, $9, $10, $10)
      ON CONFLICT (service, connection_name) DO UPDATE SET
        display_name = EXCLUDED.display_name,
        security_domain = EXCLUDED.security_domain,
        authorization_mode = EXCLUDED.authorization_mode,
        wecom_organization_id = EXCLUDED.wecom_organization_id,
        action_ids = EXCLUDED.action_ids,
        enabled = EXCLUDED.enabled,
        updated_by = EXCLUDED.updated_by,
        updated_at = NOW()
      RETURNING id
    `, [
      id,
      service,
      connectionName,
      displayName,
      securityDomain,
      authorizationMode,
      wecomOrganizationId,
      JSON.stringify(actionIds),
      input.enabled !== false,
      actor,
    ]);
    const resourceId = result.rows[0]?.id;
    if (!resourceId) throw new IntegrationStoreError("共享连接保存失败", 500);
    await replaceGrants(client, resourceId, actor, grants);
    await client.query("COMMIT");
    if (service === "wecom_bot") globalThis.aiBaseWeComVisibilityCache = undefined;
    return (await readResources()).find((resource) => resource.id === resourceId);
  } catch (error) {
    await client.query("ROLLBACK");
    throw error;
  } finally {
    client.release();
  }
}

export async function deleteSharedConnectorResource(identity: ConsoleIdentity, id: string) {
  await ensureSchema();
  const resourceId = requiredText(id, "共享连接 ID", 64);
  const result = await getPool().query(
    "DELETE FROM shared_connector_resources WHERE id = $1 RETURNING id",
    [resourceId],
  );
  if (!result.rowCount) throw new IntegrationStoreError("共享连接授权不存在", 404);
  globalThis.aiBaseWeComVisibilityCache = undefined;
  void identity;
  return { deleted: true };
}

export async function deleteSharedConnectorResourceByConnection(
  identity: ConsoleIdentity,
  service: string,
  connectionName: string,
) {
  await ensureSchema();
  await getPool().query(
    "DELETE FROM shared_connector_resources WHERE service = $1 AND connection_name = $2",
    [service, connectionName],
  );
  if (service === "wecom_bot") globalThis.aiBaseWeComVisibilityCache = undefined;
  void identity;
}
