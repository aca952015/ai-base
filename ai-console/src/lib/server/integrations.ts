import { createCipheriv, createDecipheriv, createHash, randomBytes, randomUUID } from "node:crypto";

import { Pool, type PoolClient, type QueryResultRow } from "pg";

import type {
  EnterpriseIntegrationGroup,
  EnterpriseIntegrationPlatform,
  EnterpriseIntegrationsSnapshot,
  EmployeeAvailableConnection,
  EmployeeConnectorBinding,
  EmployeeConnectorBindingStatus,
  EmployeeIntegrationApplication,
  EmployeeIntegrationsSnapshot,
  IntegrationActionOption,
  IntegrationApplication,
} from "../control-plane/integrations";
import {
  classifyConnectorConnections,
  connectorConnectionKey,
  type ConnectorProviderDetail,
  type ConnectorConnectionsSnapshot,
} from "../control-plane/connectors";
import type { ConsoleIdentity } from "./console-identity";
import {
  DEFAULT_WECOM_AUTHENTICATION_RUNTIME_SETTINGS,
  readConfig,
  removeLegacyWeComAuthenticationSettings,
} from "./config";
import {
  deleteConnectorConnection,
  getConnectorProvider,
  listConnectorConnections,
  OpenConnectorError,
  runConnectorAction,
  saveConnectorConnection,
  saveConnectorOAuthConfig,
  startConnectorOAuthAuthorization,
} from "./open-connector";
import {
  bootstrapWeComBotQrCredential,
  createWeComBotQrSession,
  pollWeComBotQrSession,
} from "./wecom-bot-qr";

const APP_ID_MAX_LENGTH = 255;
const APP_NAME_MAX_LENGTH = 120;
const APP_NOTE_MAX_LENGTH = 500;
const APP_SECRET_MAX_LENGTH = 4_096;
const ACTION_IDS_MAX_COUNT = 1_000;
const ENCRYPTION_VERSION = "v1";
const FEISHU_DEFAULT_ACTION_IDS = [
  "feishu.get_current_user",
  "feishu.get_document",
  "feishu.get_document_content",
  "feishu.list_document_blocks",
  "feishu.list_bitable_tables",
  "feishu.list_bitable_fields",
  "feishu.search_bitable_records",
];
const WECOM_BOT_WEBHOOK_ACTION_IDS = new Set([
  "wecom_bot.send_text_message",
  "wecom_bot.send_markdown_message",
  "wecom_bot.send_markdown_v2_message",
  "wecom_bot.send_image_message",
  "wecom_bot.send_news_message",
]);
const WECOM_BOT_PERSONAL_READ_ACTION_NAMES = new Set([
  "list_tools",
  "get_userlist",
  "get_msg_chat_list",
  "get_message",
  "download_message_media",
  "search_todo_userid",
  "get_todo_list",
  "get_todo_detail",
  "list_user_meetings",
  "get_meeting_info",
  "get_schedule_list_by_range",
  "get_schedule_detail",
  "check_availability",
  "get_doc_content",
  "sheet_get_info",
  "smartsheet_get_sheet",
  "smartsheet_get_fields",
  "smartsheet_get_records",
]);
const WECOM_BOT_TOOL_CATEGORIES = ["contact", "doc", "meeting", "msg", "schedule", "todo"] as const;

type EmployeeBindingMode = "oauth2" | "unsupported";

type PlatformDefinition = Omit<EnterpriseIntegrationGroup, "applications"> & {
  service?: string;
  bindingMode: EmployeeBindingMode;
  excludedActionIds?: ReadonlySet<string>;
};

const platformDefinitions: PlatformDefinition[] = [
  {
    platform: "feishu",
    displayName: "飞书",
    description: "管理飞书开放平台应用凭据。",
    service: "feishu",
    bindingMode: "oauth2",
    actions: [],
    defaultActionIds: FEISHU_DEFAULT_ACTION_IDS,
    oauthBaseScopes: [],
  },
  {
    platform: "dingtalk",
    displayName: "钉钉",
    description: "管理钉钉开放平台应用凭据。",
    bindingMode: "unsupported",
    actions: [],
    defaultActionIds: [],
    oauthBaseScopes: [],
  },
];

const allowedPlatforms = new Set(platformDefinitions.map((definition) => definition.platform));

type IntegrationApplicationRow = QueryResultRow & {
  id: string;
  platform: EnterpriseIntegrationPlatform;
  app_name: string;
  app_id: string;
  note: string;
  action_ids: unknown;
  active: boolean;
  app_secret_ciphertext?: string;
  created_at: Date | string;
  updated_at: Date | string;
};

type EmployeeConnectorBindingRow = QueryResultRow & {
  id: string;
  application_id: string | null;
  platform: EnterpriseIntegrationPlatform;
  service: string;
  connection_name: string;
  principal_email: string;
  principal_name: string;
  status: EmployeeConnectorBindingStatus;
  display_name: string | null;
  account_id: string | null;
  error_message: string | null;
  connected_at: Date | string | null;
  updated_at: Date | string;
  action_ids?: unknown;
  credential_fingerprint?: string | null;
};

type WeComBotAuthorizationRequestRow = QueryResultRow & {
  request_hash: string;
  scode: string | null;
  principal_issuer: string;
  principal_subject: string;
  expires_at: Date | string;
  processing_at: Date | string | null;
  completed_at: Date | string | null;
  connection_name: string | null;
};

type SharedConnectorGrantResolutionRow = QueryResultRow & {
  resource_id: string;
  service: string;
  connection_name: string;
  display_name: string;
  action_ids: unknown;
  grant_id: string;
};

type WeComVisibilityResourceRow = QueryResultRow & {
  resource_id: string;
  service: "wecom_bot";
  connection_name: string;
  display_name: string;
  action_ids: unknown;
  wecom_organization_id: string;
};

type WeComIdentityLinkRow = QueryResultRow & {
  id: string;
  organization_id: string;
  organization_name?: string;
  principal_issuer: string;
  principal_subject: string;
  principal_email?: string;
  principal_name?: string;
  wecom_issuer: string;
  wecom_subject: string;
  wecom_corp_id_hash: string;
  wecom_user_id_hash: string;
  linked_at: Date | string;
  updated_at: Date | string;
};

type WeComIdentityLoginRequestRow = QueryResultRow & {
  request_hash: string;
  browser_nonce_hash: string;
  organization_id: string | null;
  wecom_issuer: string | null;
  wecom_subject: string | null;
  wecom_corp_id_hash: string | null;
  wecom_user_id_hash: string | null;
  created_at: Date | string;
  expires_at: Date | string;
  verified_at: Date | string | null;
  consumed_at: Date | string | null;
};

export type WeComLinkedPlatformIdentity = {
  linkId: string;
  organizationId: string;
  principalIssuer: string;
  principalSubject: string;
  email: string;
  name: string;
};

type WeComIdentityLinkRequestRow = QueryResultRow & {
  request_hash: string;
  browser_nonce_hash: string;
  principal_issuer: string;
  principal_subject: string;
  principal_email: string;
  principal_name: string;
  created_at: Date | string;
  expires_at: Date | string;
  consumed_at: Date | string | null;
};

declare global {
  var aiBaseIntegrationPool: Pool | undefined;
  var aiBaseIntegrationSchemaPromise: Promise<void> | undefined;
  var aiBaseWeComBotMigrationPromise: Promise<void> | undefined;
  var aiBaseWeComVisibilityCache: Map<string, { expiresAt: number; userIdHashes: Set<string> }> | undefined;
}

export class IntegrationStoreError extends Error {
  readonly status: number;
  readonly code?: string;
  readonly details?: Record<string, unknown>;

  constructor(message: string, status = 500, code?: string, details?: Record<string, unknown>) {
    super(message);
    this.name = "IntegrationStoreError";
    this.status = status;
    this.code = code;
    this.details = details;
  }
}

function databaseUrl() {
  const value = process.env.DATABASE_URL?.trim();
  if (!value) throw new IntegrationStoreError("AI Console 数据库连接未配置", 503);
  return value;
}

export function getPool() {
  if (!globalThis.aiBaseIntegrationPool) {
    globalThis.aiBaseIntegrationPool = new Pool({
      connectionString: databaseUrl(),
      max: 5,
      idleTimeoutMillis: 30_000,
      connectionTimeoutMillis: 5_000,
    });
  }
  return globalThis.aiBaseIntegrationPool;
}

export async function ensureSchema() {
  if (!globalThis.aiBaseIntegrationSchemaPromise) {
    globalThis.aiBaseIntegrationSchemaPromise = getPool().query(`
      CREATE TABLE IF NOT EXISTS integration_applications (
        id UUID PRIMARY KEY,
        platform TEXT NOT NULL CHECK (platform IN ('feishu', 'wecom', 'wecom_bot', 'dingtalk')),
        app_name TEXT NOT NULL,
        app_id TEXT NOT NULL,
        note TEXT NOT NULL DEFAULT '',
        action_ids JSONB NOT NULL DEFAULT '[]'::JSONB,
        active BOOLEAN NOT NULL DEFAULT FALSE,
        app_secret_ciphertext TEXT NOT NULL,
        created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
        updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
        UNIQUE (platform, app_id)
      );
      ALTER TABLE integration_applications
        DROP CONSTRAINT IF EXISTS integration_applications_platform_check;
      ALTER TABLE integration_applications
        ADD CONSTRAINT integration_applications_platform_check
        CHECK (platform IN ('feishu', 'wecom', 'wecom_bot', 'dingtalk'));
      ALTER TABLE integration_applications ADD COLUMN IF NOT EXISTS app_name TEXT;
      UPDATE integration_applications
      SET app_name = app_id
      WHERE app_name IS NULL OR BTRIM(app_name) = '';
      ALTER TABLE integration_applications ALTER COLUMN app_name SET NOT NULL;
      ALTER TABLE integration_applications ADD COLUMN IF NOT EXISTS note TEXT;
      UPDATE integration_applications SET note = '' WHERE note IS NULL;
      ALTER TABLE integration_applications ALTER COLUMN note SET DEFAULT '';
      ALTER TABLE integration_applications ALTER COLUMN note SET NOT NULL;
      ALTER TABLE integration_applications
        ADD COLUMN IF NOT EXISTS action_ids JSONB NOT NULL DEFAULT '[]'::JSONB;
      UPDATE integration_applications
      SET action_ids = '[
        "feishu.get_current_user",
        "feishu.get_document",
        "feishu.get_document_content",
        "feishu.list_document_blocks",
        "feishu.list_bitable_tables",
        "feishu.list_bitable_fields",
        "feishu.search_bitable_records"
      ]'::JSONB
      WHERE platform = 'feishu' AND action_ids = '[]'::JSONB;
      ALTER TABLE integration_applications ADD COLUMN IF NOT EXISTS active BOOLEAN NOT NULL DEFAULT FALSE;
      UPDATE integration_applications AS application
      SET active = TRUE
      WHERE application.id IN (
        SELECT DISTINCT ON (candidate.platform) candidate.id
        FROM integration_applications AS candidate
        WHERE NOT EXISTS (
          SELECT 1
          FROM integration_applications AS enabled
          WHERE enabled.platform = candidate.platform AND enabled.active
        )
        ORDER BY candidate.platform, candidate.created_at, candidate.id
      );
      CREATE UNIQUE INDEX IF NOT EXISTS integration_applications_one_active_per_platform
        ON integration_applications(platform) WHERE active;
      CREATE TABLE IF NOT EXISTS wecom_authentication_configuration (
        singleton_key TEXT PRIMARY KEY DEFAULT 'default' CHECK (singleton_key = 'default'),
        corp_id TEXT NOT NULL DEFAULT '',
        app_secret_ciphertext TEXT,
        public_base_url TEXT NOT NULL,
        callback_mode TEXT NOT NULL CHECK (callback_mode IN ('direct', 'relay')),
        relay_callback_url TEXT,
        email_domain TEXT NOT NULL,
        created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
        updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
        CHECK (callback_mode = 'direct' OR (relay_callback_url IS NOT NULL AND BTRIM(relay_callback_url) <> ''))
      );
      CREATE TABLE IF NOT EXISTS wecom_identity_links (
        principal_issuer TEXT NOT NULL,
        principal_subject TEXT NOT NULL,
        principal_email TEXT NOT NULL,
        principal_name TEXT NOT NULL,
        wecom_issuer TEXT NOT NULL,
        wecom_subject TEXT NOT NULL,
        wecom_corp_id_hash CHAR(64) NOT NULL CHECK (wecom_corp_id_hash ~ '^[a-f0-9]{64}$'),
        wecom_user_id_hash CHAR(64) NOT NULL CHECK (wecom_user_id_hash ~ '^[a-f0-9]{64}$'),
        linked_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
        updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
        PRIMARY KEY (principal_issuer, principal_subject),
        UNIQUE (wecom_issuer, wecom_subject),
        UNIQUE (wecom_corp_id_hash, wecom_user_id_hash)
      );
      CREATE TABLE IF NOT EXISTS wecom_identity_link_requests (
        request_hash CHAR(64) PRIMARY KEY CHECK (request_hash ~ '^[a-f0-9]{64}$'),
        browser_nonce_hash CHAR(64) NOT NULL CHECK (browser_nonce_hash ~ '^[a-f0-9]{64}$'),
        principal_issuer TEXT NOT NULL,
        principal_subject TEXT NOT NULL,
        principal_email TEXT NOT NULL,
        principal_name TEXT NOT NULL,
        created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
        expires_at TIMESTAMPTZ NOT NULL,
        consumed_at TIMESTAMPTZ
      );
      CREATE INDEX IF NOT EXISTS wecom_identity_link_requests_principal_idx
        ON wecom_identity_link_requests(principal_issuer, principal_subject, expires_at);
      CREATE TABLE IF NOT EXISTS wecom_identity_login_requests (
        request_hash CHAR(64) PRIMARY KEY CHECK (request_hash ~ '^[a-f0-9]{64}$'),
        browser_nonce_hash CHAR(64) NOT NULL CHECK (browser_nonce_hash ~ '^[a-f0-9]{64}$'),
        wecom_issuer TEXT,
        wecom_subject TEXT,
        wecom_corp_id_hash CHAR(64) CHECK (wecom_corp_id_hash IS NULL OR wecom_corp_id_hash ~ '^[a-f0-9]{64}$'),
        wecom_user_id_hash CHAR(64) CHECK (wecom_user_id_hash IS NULL OR wecom_user_id_hash ~ '^[a-f0-9]{64}$'),
        created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
        expires_at TIMESTAMPTZ NOT NULL,
        verified_at TIMESTAMPTZ,
        consumed_at TIMESTAMPTZ,
        CHECK (
          (wecom_issuer IS NULL AND wecom_subject IS NULL AND wecom_corp_id_hash IS NULL AND wecom_user_id_hash IS NULL AND verified_at IS NULL)
          OR
          (wecom_issuer IS NOT NULL AND wecom_subject IS NOT NULL AND wecom_corp_id_hash IS NOT NULL AND wecom_user_id_hash IS NOT NULL AND verified_at IS NOT NULL)
        )
      );
      CREATE TABLE IF NOT EXISTS employee_connector_bindings (
        id UUID PRIMARY KEY,
        application_id UUID REFERENCES integration_applications(id) ON DELETE RESTRICT,
        principal_issuer TEXT NOT NULL,
        principal_subject TEXT NOT NULL,
        principal_email TEXT NOT NULL,
        principal_name TEXT NOT NULL,
        platform TEXT NOT NULL CHECK (platform IN ('feishu', 'wecom', 'wecom_bot', 'dingtalk')),
        service TEXT NOT NULL,
        connection_name TEXT NOT NULL,
        status TEXT NOT NULL CHECK (status IN ('pending', 'connected', 'error', 'revoked')),
        display_name TEXT,
        account_id TEXT,
        error_message TEXT,
        action_ids JSONB,
        credential_fingerprint CHAR(64) CHECK (
          credential_fingerprint IS NULL OR credential_fingerprint ~ '^[a-f0-9]{64}$'
        ),
        connected_at TIMESTAMPTZ,
        created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
        updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
        UNIQUE (service, connection_name)
      );
      ALTER TABLE employee_connector_bindings
        ALTER COLUMN application_id DROP NOT NULL;
      ALTER TABLE employee_connector_bindings
        ADD COLUMN IF NOT EXISTS action_ids JSONB;
      ALTER TABLE employee_connector_bindings
        ADD COLUMN IF NOT EXISTS credential_fingerprint CHAR(64);
      ALTER TABLE employee_connector_bindings
        DROP CONSTRAINT IF EXISTS employee_connector_bindings_platform_check;
      ALTER TABLE employee_connector_bindings
        ADD CONSTRAINT employee_connector_bindings_platform_check
        CHECK (platform IN ('feishu', 'wecom', 'wecom_bot', 'dingtalk'));
      ALTER TABLE employee_connector_bindings
        DROP CONSTRAINT IF EXISTS employee_connector_bindings_credential_fingerprint_check;
      ALTER TABLE employee_connector_bindings
        ADD CONSTRAINT employee_connector_bindings_credential_fingerprint_check
        CHECK (credential_fingerprint IS NULL OR credential_fingerprint ~ '^[a-f0-9]{64}$');
      ALTER TABLE employee_connector_bindings
        DROP CONSTRAINT IF EXISTS employee_connector_bindings_application_check;
      ALTER TABLE employee_connector_bindings
        ADD CONSTRAINT employee_connector_bindings_application_check
        CHECK (application_id IS NOT NULL OR platform = 'wecom_bot');
      DO $$
      DECLARE legacy_constraint TEXT;
      BEGIN
        SELECT constraint_row.conname INTO legacy_constraint
        FROM pg_constraint AS constraint_row
        JOIN pg_class AS relation_row ON relation_row.oid = constraint_row.conrelid
        WHERE relation_row.relname = 'employee_connector_bindings'
          AND constraint_row.contype = 'u'
          AND pg_get_constraintdef(constraint_row.oid) = 'UNIQUE (principal_issuer, principal_subject, service)'
        LIMIT 1;
        IF legacy_constraint IS NOT NULL THEN
          EXECUTE format('ALTER TABLE employee_connector_bindings DROP CONSTRAINT %I', legacy_constraint);
        END IF;
      END $$;
      CREATE UNIQUE INDEX IF NOT EXISTS employee_connector_bindings_one_application_service_per_user
        ON employee_connector_bindings(principal_issuer, principal_subject, service)
        WHERE application_id IS NOT NULL;
      CREATE UNIQUE INDEX IF NOT EXISTS employee_connector_bindings_active_credential_fingerprint
        ON employee_connector_bindings(credential_fingerprint)
        WHERE credential_fingerprint IS NOT NULL AND status <> 'revoked';
      CREATE INDEX IF NOT EXISTS employee_connector_bindings_principal_idx
        ON employee_connector_bindings(principal_issuer, principal_subject, status);
      CREATE TABLE IF NOT EXISTS wecom_bot_authorization_requests (
        request_hash CHAR(64) PRIMARY KEY CHECK (request_hash ~ '^[a-f0-9]{64}$'),
        scode TEXT,
        principal_issuer TEXT NOT NULL,
        principal_subject TEXT NOT NULL,
        expires_at TIMESTAMPTZ NOT NULL,
        processing_at TIMESTAMPTZ,
        completed_at TIMESTAMPTZ,
        connection_name TEXT,
        created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
        CHECK ((completed_at IS NULL AND connection_name IS NULL) OR (completed_at IS NOT NULL AND connection_name IS NOT NULL))
      );
      ALTER TABLE wecom_bot_authorization_requests
        ALTER COLUMN scode DROP NOT NULL;
      CREATE INDEX IF NOT EXISTS wecom_bot_authorization_requests_principal_idx
        ON wecom_bot_authorization_requests(principal_issuer, principal_subject, expires_at);
      CREATE TABLE IF NOT EXISTS shared_connector_resources (
        id UUID PRIMARY KEY,
        service TEXT NOT NULL,
        connection_name TEXT NOT NULL,
        display_name TEXT NOT NULL,
        security_domain TEXT NOT NULL DEFAULT 'general',
        authorization_mode TEXT NOT NULL DEFAULT 'manual'
          CHECK (authorization_mode IN ('manual', 'wecom_visibility')),
        action_ids JSONB NOT NULL DEFAULT '[]'::JSONB,
        enabled BOOLEAN NOT NULL DEFAULT TRUE,
        created_by TEXT NOT NULL,
        updated_by TEXT NOT NULL,
        created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
        updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
        UNIQUE (service, connection_name)
      );
      ALTER TABLE shared_connector_resources
        ADD COLUMN IF NOT EXISTS authorization_mode TEXT NOT NULL DEFAULT 'manual';
      ALTER TABLE shared_connector_resources
        DROP CONSTRAINT IF EXISTS shared_connector_resources_authorization_mode_check;
      ALTER TABLE shared_connector_resources
        ADD CONSTRAINT shared_connector_resources_authorization_mode_check
        CHECK (authorization_mode IN ('manual', 'wecom_visibility'));
      ALTER TABLE shared_connector_resources
        ADD COLUMN IF NOT EXISTS action_ids JSONB NOT NULL DEFAULT '[]'::JSONB;
      CREATE TABLE IF NOT EXISTS shared_connector_grants (
        id UUID PRIMARY KEY,
        resource_id UUID NOT NULL REFERENCES shared_connector_resources(id) ON DELETE CASCADE,
        principal_type TEXT NOT NULL CHECK (principal_type IN ('user', 'group')),
        principal_issuer TEXT NOT NULL,
        principal_subject TEXT,
        principal_email TEXT,
        group_name TEXT,
        action_ids JSONB NOT NULL DEFAULT '[]'::JSONB,
        starts_at TIMESTAMPTZ,
        expires_at TIMESTAMPTZ,
        enabled BOOLEAN NOT NULL DEFAULT TRUE,
        created_by TEXT NOT NULL,
        updated_by TEXT NOT NULL,
        created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
        updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
        CHECK (
          (principal_type = 'user' AND (principal_subject IS NOT NULL OR principal_email IS NOT NULL))
          OR (principal_type = 'group' AND group_name IS NOT NULL)
        )
      );
      CREATE INDEX IF NOT EXISTS shared_connector_grants_resource_idx
        ON shared_connector_grants(resource_id, enabled);
      CREATE INDEX IF NOT EXISTS shared_connector_grants_user_idx
        ON shared_connector_grants(principal_issuer, principal_subject, enabled)
        WHERE principal_type = 'user';
      CREATE INDEX IF NOT EXISTS shared_connector_grants_group_idx
        ON shared_connector_grants(principal_issuer, group_name, enabled)
        WHERE principal_type = 'group'
    `).then(async () => {
      await migrateLegacyWeComAuthenticationConfiguration();
      await migrateWeComMultiOrganizationSchema();
    }).catch((error: unknown) => {
      globalThis.aiBaseIntegrationSchemaPromise = undefined;
      throw error;
    });
  }
  return globalThis.aiBaseIntegrationSchemaPromise;
}

async function migrateLegacyWeComAuthenticationConfiguration() {
  const config = await readConfig();
  const legacyRuntime = config.authentication?.wecom;
  const runtime = legacyRuntime ?? DEFAULT_WECOM_AUTHENTICATION_RUNTIME_SETTINGS;
  const client = await getPool().connect();
  try {
    await client.query("BEGIN");
    await client.query("SELECT pg_advisory_xact_lock(hashtext('ai_base_wecom_authentication_configuration'))");
    const current = await client.query<{ corp_id: string; app_secret_ciphertext: string | null }>(`
      SELECT corp_id, app_secret_ciphertext
      FROM wecom_authentication_configuration
      WHERE singleton_key = 'default'
      FOR UPDATE
    `);
    const legacy = await client.query<Pick<IntegrationApplicationRow, "app_id" | "app_secret_ciphertext">>(`
      SELECT app_id, app_secret_ciphertext
      FROM integration_applications
      WHERE platform = 'wecom'
      ORDER BY active DESC, updated_at DESC, created_at DESC, id
      LIMIT 1
    `);
    const legacyApplication = legacy.rows[0];
    if (!current.rows[0]) {
      await client.query(`
        INSERT INTO wecom_authentication_configuration (
          singleton_key, corp_id, app_secret_ciphertext, public_base_url,
          callback_mode, relay_callback_url, email_domain
        ) VALUES ('default', $1, $2, $3, $4, $5, $6)
      `, [
        legacyApplication?.app_id || "",
        legacyApplication?.app_secret_ciphertext || null,
        runtime.publicBaseUrl,
        runtime.callbackMode,
        runtime.callbackMode === "relay" ? runtime.relayCallbackUrl || null : null,
        runtime.emailDomain,
      ]);
    } else if (
      legacyApplication
      && !current.rows[0].corp_id
      && !current.rows[0].app_secret_ciphertext
    ) {
      await client.query(`
        UPDATE wecom_authentication_configuration
        SET corp_id = $1, app_secret_ciphertext = $2, updated_at = NOW()
        WHERE singleton_key = 'default'
      `, [legacyApplication.app_id, legacyApplication.app_secret_ciphertext]);
    }
    await client.query(`
      DELETE FROM employee_connector_bindings
      WHERE application_id IN (
        SELECT id FROM integration_applications WHERE platform = 'wecom'
      )
    `);
    await client.query("DELETE FROM integration_applications WHERE platform = 'wecom'");
    await client.query("COMMIT");
  } catch (error) {
    await client.query("ROLLBACK");
    throw error;
  } finally {
    client.release();
  }
  if (legacyRuntime) await removeLegacyWeComAuthenticationSettings();
}

async function migrateWeComMultiOrganizationSchema() {
  await getPool().query(`
    CREATE TABLE IF NOT EXISTS wecom_authentication_organizations (
      id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
      organization_name TEXT NOT NULL,
      corp_id TEXT NOT NULL UNIQUE,
      app_secret_ciphertext TEXT,
      relay_callback_url TEXT,
      active BOOLEAN NOT NULL DEFAULT TRUE,
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      CHECK (relay_callback_url IS NULL OR BTRIM(relay_callback_url) <> '')
    );
    ALTER TABLE wecom_authentication_configuration
      ADD COLUMN IF NOT EXISTS organizations_migrated_at TIMESTAMPTZ;
    INSERT INTO wecom_authentication_organizations (
      id, organization_name, corp_id, app_secret_ciphertext,
      relay_callback_url, active, created_at, updated_at
    )
    SELECT
      '00000000-0000-0000-0000-000000000001'::UUID,
      '默认组织', corp_id, app_secret_ciphertext, relay_callback_url,
      TRUE, created_at, updated_at
    FROM wecom_authentication_configuration
    WHERE singleton_key = 'default'
      AND organizations_migrated_at IS NULL
      AND BTRIM(corp_id) <> ''
      AND NOT EXISTS (SELECT 1 FROM wecom_authentication_organizations)
    ON CONFLICT (corp_id) DO UPDATE SET
      app_secret_ciphertext = COALESCE(
        wecom_authentication_organizations.app_secret_ciphertext,
        EXCLUDED.app_secret_ciphertext
      ),
      relay_callback_url = COALESCE(
        wecom_authentication_organizations.relay_callback_url,
        EXCLUDED.relay_callback_url
      );
    UPDATE wecom_authentication_configuration
    SET organizations_migrated_at = COALESCE(organizations_migrated_at, NOW())
    WHERE singleton_key = 'default';
    ALTER TABLE wecom_identity_login_requests
      ADD COLUMN IF NOT EXISTS organization_id UUID;
    ALTER TABLE wecom_identity_links
      ADD COLUMN IF NOT EXISTS id UUID DEFAULT gen_random_uuid();
    ALTER TABLE wecom_identity_links
      ADD COLUMN IF NOT EXISTS organization_id UUID;
    UPDATE wecom_identity_login_requests
    SET organization_id = '00000000-0000-0000-0000-000000000001'::UUID
    WHERE organization_id IS NULL
      AND EXISTS (
        SELECT 1 FROM wecom_authentication_organizations
        WHERE id = '00000000-0000-0000-0000-000000000001'::UUID
      );
    UPDATE wecom_identity_links
    SET organization_id = '00000000-0000-0000-0000-000000000001'::UUID
    WHERE organization_id IS NULL
      AND EXISTS (
        SELECT 1 FROM wecom_authentication_organizations
        WHERE id = '00000000-0000-0000-0000-000000000001'::UUID
      );
    DO $$
    BEGIN
      IF EXISTS (SELECT 1 FROM wecom_identity_links WHERE organization_id IS NULL) THEN
        RAISE EXCEPTION 'Cannot migrate WeCom identities without a matching organization';
      END IF;
    END $$;
    ALTER TABLE wecom_identity_links
      ALTER COLUMN id SET NOT NULL,
      ALTER COLUMN organization_id SET NOT NULL;
    DO $$
    DECLARE current_columns TEXT;
    BEGIN
      SELECT string_agg(attribute.attname, ',' ORDER BY key_column.ordinality)
      INTO current_columns
      FROM pg_constraint AS constraint_row
      JOIN LATERAL unnest(constraint_row.conkey) WITH ORDINALITY AS key_column(attnum, ordinality) ON TRUE
      JOIN pg_attribute AS attribute
        ON attribute.attrelid = constraint_row.conrelid AND attribute.attnum = key_column.attnum
      WHERE constraint_row.conrelid = 'wecom_identity_links'::regclass
        AND constraint_row.contype = 'p';
      IF current_columns IS DISTINCT FROM 'id' THEN
        ALTER TABLE wecom_identity_links DROP CONSTRAINT IF EXISTS wecom_identity_links_pkey;
      END IF;
      IF NOT EXISTS (
        SELECT 1 FROM pg_constraint
        WHERE conrelid = 'wecom_identity_links'::regclass AND contype = 'p'
      ) THEN
        ALTER TABLE wecom_identity_links
          ADD CONSTRAINT wecom_identity_links_pkey PRIMARY KEY (id);
      END IF;
    END $$;
    CREATE UNIQUE INDEX IF NOT EXISTS wecom_identity_links_principal_organization_idx
      ON wecom_identity_links(principal_issuer, principal_subject, organization_id);
    DO $$
    BEGIN
      IF NOT EXISTS (
        SELECT 1 FROM pg_constraint
        WHERE conname = 'wecom_identity_links_organization_fk'
          AND conrelid = 'wecom_identity_links'::regclass
      ) THEN
        ALTER TABLE wecom_identity_links
          ADD CONSTRAINT wecom_identity_links_organization_fk
          FOREIGN KEY (organization_id) REFERENCES wecom_authentication_organizations(id) ON DELETE RESTRICT;
      END IF;
      IF NOT EXISTS (
        SELECT 1 FROM pg_constraint
        WHERE conname = 'wecom_identity_login_requests_organization_fk'
          AND conrelid = 'wecom_identity_login_requests'::regclass
      ) THEN
        ALTER TABLE wecom_identity_login_requests
          ADD CONSTRAINT wecom_identity_login_requests_organization_fk
          FOREIGN KEY (organization_id) REFERENCES wecom_authentication_organizations(id) ON DELETE RESTRICT;
      END IF;
    END $$;
    ALTER TABLE shared_connector_resources
      ADD COLUMN IF NOT EXISTS wecom_organization_id UUID;
    UPDATE shared_connector_resources
    SET wecom_organization_id = '00000000-0000-0000-0000-000000000001'::UUID
    WHERE authorization_mode = 'wecom_visibility'
      AND wecom_organization_id IS NULL
      AND EXISTS (
        SELECT 1 FROM wecom_authentication_organizations
        WHERE id = '00000000-0000-0000-0000-000000000001'::UUID
      );
    DO $$
    BEGIN
      IF EXISTS (
        SELECT 1 FROM shared_connector_resources
        WHERE authorization_mode = 'wecom_visibility' AND wecom_organization_id IS NULL
      ) THEN
        RAISE EXCEPTION 'Cannot migrate WeCom shared connectors without a matching organization';
      END IF;
      IF NOT EXISTS (
        SELECT 1 FROM pg_constraint
        WHERE conname = 'shared_connector_resources_wecom_organization_fk'
          AND conrelid = 'shared_connector_resources'::regclass
      ) THEN
        ALTER TABLE shared_connector_resources
          ADD CONSTRAINT shared_connector_resources_wecom_organization_fk
          FOREIGN KEY (wecom_organization_id) REFERENCES wecom_authentication_organizations(id) ON DELETE RESTRICT;
      END IF;
    END $$;
    ALTER TABLE shared_connector_resources
      DROP CONSTRAINT IF EXISTS shared_connector_resources_wecom_organization_check;
    ALTER TABLE shared_connector_resources
      ADD CONSTRAINT shared_connector_resources_wecom_organization_check
      CHECK (
        (authorization_mode = 'wecom_visibility' AND wecom_organization_id IS NOT NULL)
        OR (authorization_mode <> 'wecom_visibility' AND wecom_organization_id IS NULL)
      );
    CREATE INDEX IF NOT EXISTS shared_connector_resources_wecom_organization_idx
      ON shared_connector_resources(wecom_organization_id)
      WHERE authorization_mode = 'wecom_visibility';
  `);
}

function encryptionKey() {
  const secret = process.env.AI_CONSOLE_SECRET_ENCRYPTION_KEY?.trim();
  if (!secret || secret.length < 32) {
    throw new IntegrationStoreError("AI Console 集成密钥未配置或长度不足 32 个字符", 503);
  }
  return createHash("sha256").update(secret, "utf8").digest();
}

export function encryptIntegrationSecret(secret: string) {
  const iv = randomBytes(12);
  const cipher = createCipheriv("aes-256-gcm", encryptionKey(), iv);
  const ciphertext = Buffer.concat([cipher.update(secret, "utf8"), cipher.final()]);
  const tag = cipher.getAuthTag();
  return [
    ENCRYPTION_VERSION,
    iv.toString("base64url"),
    tag.toString("base64url"),
    ciphertext.toString("base64url"),
  ].join(".");
}

export function decryptIntegrationSecret(payload: string) {
  const [version, ivValue, tagValue, ciphertextValue, ...extra] = payload.split(".");
  if (
    version !== ENCRYPTION_VERSION
    || !ivValue
    || !tagValue
    || !ciphertextValue
    || extra.length
  ) {
    throw new IntegrationStoreError("集成应用密钥格式无效", 500);
  }
  try {
    const decipher = createDecipheriv("aes-256-gcm", encryptionKey(), Buffer.from(ivValue, "base64url"));
    decipher.setAuthTag(Buffer.from(tagValue, "base64url"));
    return Buffer.concat([
      decipher.update(Buffer.from(ciphertextValue, "base64url")),
      decipher.final(),
    ]).toString("utf8");
  } catch {
    throw new IntegrationStoreError("无法解密集成应用密钥", 500);
  }
}

const WECOM_BOT_SYSTEM_ONLY_ACTION_IDS = new Set([
  ...WECOM_BOT_WEBHOOK_ACTION_IDS,
  "wecom_bot.call_tool",
]);

function migratedWeComBotConnectionName(applicationId: string) {
  return `wecom_bot_${applicationId.replaceAll("-", "")}`;
}

async function migrateLegacyWeComBotIntegrations() {
  if (!globalThis.aiBaseWeComBotMigrationPromise) {
    globalThis.aiBaseWeComBotMigrationPromise = (async () => {
      const legacy = await getPool().query<IntegrationApplicationRow>(`
        SELECT id, platform, app_name, app_id, note, action_ids, active,
               app_secret_ciphertext, created_at, updated_at
        FROM integration_applications
        WHERE platform = 'wecom_bot'
        ORDER BY created_at, id
      `);
      if (!legacy.rowCount) return;

      const provider = await getConnectorProvider("wecom_bot");
      const availableActionIds = new Set(provider.actions
        .filter((action) => action.execution?.catalogOnly !== true)
        .map((action) => action.id));
      const organization = await getPool().query<{ id: string }>(`
        SELECT id FROM wecom_authentication_organizations
        WHERE active AND corp_id <> '' AND app_secret_ciphertext IS NOT NULL
        ORDER BY created_at, id
        LIMIT 1
      `);
      const organizationId = organization.rows[0]?.id;
      if (!organizationId) {
        throw new IntegrationStoreError("迁移企微机器人前必须先配置企业微信认证组织", 409);
      }

      for (const row of legacy.rows) {
        if (!row.app_secret_ciphertext) {
          throw new IntegrationStoreError(`企微机器人 ${row.app_name} 的凭据不完整，无法迁移`, 409);
        }
        const connectionName = migratedWeComBotConnectionName(row.id);
        const actionIds = storedActionIds(row.action_ids).filter((actionId) => (
          availableActionIds.has(actionId) && !WECOM_BOT_SYSTEM_ONLY_ACTION_IDS.has(actionId)
        ));
        const connection = await saveConnectorConnection("wecom_bot", {
          connectionName,
          authType: "custom_credential",
          values: {
            botId: row.app_id,
            secret: decryptIntegrationSecret(row.app_secret_ciphertext),
          },
        });
        if (!connection?.configured) {
          throw new IntegrationStoreError(`企微机器人 ${row.app_name} 无法迁移为共享连接`, 502);
        }

        const bindings = await getPool().query<{ service: string; connection_name: string }>(`
          SELECT service, connection_name
          FROM employee_connector_bindings
          WHERE application_id = $1
        `, [row.id]);
        const client = await getPool().connect();
        try {
          await client.query("BEGIN");
          await client.query(`
            INSERT INTO shared_connector_resources (
              id, service, connection_name, display_name, security_domain,
              authorization_mode, wecom_organization_id, action_ids, enabled, created_by, updated_by
            ) VALUES ($1, 'wecom_bot', $2, $3, 'wecom', 'wecom_visibility', $4, $5::JSONB, $6, $7, $7)
            ON CONFLICT (service, connection_name) DO UPDATE SET
              display_name = EXCLUDED.display_name,
              security_domain = 'wecom',
              authorization_mode = 'wecom_visibility',
              wecom_organization_id = EXCLUDED.wecom_organization_id,
              action_ids = EXCLUDED.action_ids,
              enabled = EXCLUDED.enabled,
              updated_by = EXCLUDED.updated_by,
              updated_at = NOW()
          `, [
            row.id,
            connectionName,
            row.app_name,
            organizationId,
            JSON.stringify(actionIds),
            row.active && actionIds.length > 0,
            "migration:wecom_bot",
          ]);
          await client.query("DELETE FROM employee_connector_bindings WHERE application_id = $1", [row.id]);
          await client.query("DELETE FROM integration_applications WHERE id = $1", [row.id]);
          await client.query("COMMIT");
        } catch (error) {
          await client.query("ROLLBACK");
          throw error;
        } finally {
          client.release();
        }

        for (const binding of bindings.rows) {
          if (binding.service === "wecom_bot" && binding.connection_name !== connectionName) {
            await deleteConnectorConnection(binding.service, binding.connection_name).catch(() => undefined);
          }
        }
      }
    })().catch((error: unknown) => {
      globalThis.aiBaseWeComBotMigrationPromise = undefined;
      throw error;
    });
  }
  return globalThis.aiBaseWeComBotMigrationPromise;
}

function normalizePlatform(value: unknown): EnterpriseIntegrationPlatform {
  if (typeof value !== "string" || !allowedPlatforms.has(value as EnterpriseIntegrationPlatform)) {
    throw new IntegrationStoreError("仅支持飞书和钉钉应用；企业微信认证组织请在对应二级页面维护，企微机器人请在连接器管理中维护", 400);
  }
  return value as EnterpriseIntegrationPlatform;
}

function requiredValue(value: unknown, label: string, maxLength: number) {
  const normalized = typeof value === "string" ? value.trim() : "";
  if (!normalized) throw new IntegrationStoreError(`${label} 不能为空`, 400);
  if (normalized.length > maxLength) throw new IntegrationStoreError(`${label} 长度不能超过 ${maxLength} 个字符`, 400);
  return normalized;
}

function requiredSecret(value: unknown) {
  if (typeof value !== "string" || !value.trim()) {
    throw new IntegrationStoreError("App Secret 不能为空", 400);
  }
  if (value.length > APP_SECRET_MAX_LENGTH) {
    throw new IntegrationStoreError(`App Secret 长度不能超过 ${APP_SECRET_MAX_LENGTH} 个字符`, 400);
  }
  return value;
}

function optionalValue(value: unknown, label: string, maxLength: number) {
  const normalized = typeof value === "string" ? value.trim() : "";
  if (normalized.length > maxLength) throw new IntegrationStoreError(`${label}长度不能超过 ${maxLength} 个字符`, 400);
  return normalized;
}

function optionalSecret(value: unknown) {
  if (value === undefined || value === null || value === "" || (typeof value === "string" && !value.trim())) {
    return undefined;
  }
  return requiredSecret(value);
}

function storedActionIds(value: unknown) {
  return Array.isArray(value)
    ? [...new Set(value.filter((item): item is string => typeof item === "string" && Boolean(item.trim()))
      .map((item) => item.trim()))]
    : [];
}

function serializeApplication(row: IntegrationApplicationRow): IntegrationApplication {
  return {
    id: row.id,
    platform: row.platform,
    name: row.app_name,
    appId: row.app_id,
    note: row.note,
    actionIds: storedActionIds(row.action_ids),
    active: row.active,
    secretConfigured: true,
    createdAt: new Date(row.created_at).toISOString(),
    updatedAt: new Date(row.updated_at).toISOString(),
  };
}

type IntegrationActionCatalog = {
  actions: IntegrationActionOption[];
  defaultActionIds: string[];
  oauthBaseScopes: string[];
};

async function integrationActionCatalog(platform: EnterpriseIntegrationPlatform): Promise<IntegrationActionCatalog> {
  const definition = platformDefinition(platform);
  if (!definition.service) {
    return {
      actions: [],
      defaultActionIds: [],
      oauthBaseScopes: [],
    };
  }

  const provider = await getConnectorProvider(definition.service);
  const actions = provider.actions
    .filter((action) => (
      action.execution?.catalogOnly !== true
      && !definition.excludedActionIds?.has(action.id)
    ))
    .map((action) => ({
      id: action.id,
      name: action.name,
      description: action.description,
      providerPermissions: action.providerPermissions,
    }))
    .sort((left, right) => left.name.localeCompare(right.name, "zh-CN"));
  const actionPermissions = new Set(actions.flatMap((action) => action.providerPermissions));
  const oauth = provider.auth.find((auth) => auth.type === "oauth2");
  const availableIds = new Set(actions.map((action) => action.id));
  return {
    actions,
    defaultActionIds: definition.defaultActionIds.filter((actionId) => availableIds.has(actionId)),
    oauthBaseScopes: oauth?.type === "oauth2"
      ? oauth.scopes.filter((scope) => !actionPermissions.has(scope))
      : [],
  };
}

async function normalizeIntegrationActionIds(
  platform: EnterpriseIntegrationPlatform,
  value: unknown,
  fallback: string[],
) {
  const actionIds = value === undefined
    ? fallback
    : Array.isArray(value)
      ? [...new Set(value.map((item) => typeof item === "string" ? item.trim() : "").filter(Boolean))]
      : undefined;
  if (!actionIds) throw new IntegrationStoreError("Action 配置必须是字符串数组", 400);
  if (actionIds.length > ACTION_IDS_MAX_COUNT) {
    throw new IntegrationStoreError(`最多选择 ${ACTION_IDS_MAX_COUNT} 个 Action`, 400);
  }

  const catalog = await integrationActionCatalog(platform);
  if (catalog.actions.length > 0 && actionIds.length === 0) {
    throw new IntegrationStoreError("至少选择一个 Action", 400);
  }
  const availableIds = new Set(catalog.actions.map((action) => action.id));
  const unknownIds = actionIds.filter((actionId) => !availableIds.has(actionId));
  if (unknownIds.length > 0) {
    throw new IntegrationStoreError(`包含不可用的 Action：${unknownIds.slice(0, 3).join("、")}`, 400);
  }
  return actionIds;
}

export function buildEnterpriseIntegrationsSnapshot(
  applications: IntegrationApplication[],
  updatedAt = new Date().toISOString(),
  actionCatalogs: Partial<Record<EnterpriseIntegrationPlatform, IntegrationActionCatalog>> = {},
): EnterpriseIntegrationsSnapshot {
  return {
    groups: platformDefinitions.map((definition) => ({
      platform: definition.platform,
      displayName: definition.displayName,
      description: definition.description,
      actions: actionCatalogs[definition.platform]?.actions ?? [],
      defaultActionIds: actionCatalogs[definition.platform]?.defaultActionIds ?? definition.defaultActionIds,
      oauthBaseScopes: actionCatalogs[definition.platform]?.oauthBaseScopes ?? [],
      applications: applications.filter((application) => application.platform === definition.platform),
    })),
    updatedAt,
  };
}

export async function getEnterpriseIntegrations(): Promise<EnterpriseIntegrationsSnapshot> {
  await ensureSchema();
  await migrateLegacyWeComBotIntegrations();
  const [result, catalogs] = await Promise.all([
    getPool().query<IntegrationApplicationRow>(`
      SELECT id, platform, app_name, app_id, note, action_ids, active, created_at, updated_at
      FROM integration_applications
      ORDER BY platform, created_at, app_name, app_id
    `),
    Promise.all(platformDefinitions.map(async (definition) => (
      [definition.platform, await integrationActionCatalog(definition.platform)] as const
    ))),
  ]);
  return buildEnterpriseIntegrationsSnapshot(
    result.rows.map(serializeApplication),
    new Date().toISOString(),
    Object.fromEntries(catalogs),
  );
}

export async function createIntegrationApplication(input: {
  platform: unknown;
  name: unknown;
  appId: unknown;
  note?: unknown;
  appSecret: unknown;
  actionIds?: unknown;
}) {
  await ensureSchema();
  const platform = normalizePlatform(input.platform);
  const name = requiredValue(input.name, "应用名称", APP_NAME_MAX_LENGTH);
  const appId = requiredValue(input.appId, "App ID", APP_ID_MAX_LENGTH);
  const note = optionalValue(input.note, "备注", APP_NOTE_MAX_LENGTH);
  const appSecret = requiredSecret(input.appSecret);
  const definition = platformDefinition(platform);
  const actionIds = await normalizeIntegrationActionIds(platform, input.actionIds, definition.defaultActionIds);
  try {
    const result = await getPool().query<IntegrationApplicationRow>(`
      INSERT INTO integration_applications (
        id, platform, app_name, app_id, note, action_ids, active, app_secret_ciphertext
      )
      VALUES (
        $1, $2, $3, $4, $5, $6::JSONB,
        NOT EXISTS (SELECT 1 FROM integration_applications WHERE platform = $2 AND active),
        $7
      )
      RETURNING id, platform, app_name, app_id, note, action_ids, active, created_at, updated_at
    `, [
      randomUUID(),
      platform,
      name,
      appId,
      note,
      JSON.stringify(actionIds),
      encryptIntegrationSecret(appSecret),
    ]);
    return serializeApplication(result.rows[0]);
  } catch (error) {
    if (isUniqueViolation(error)) throw new IntegrationStoreError("该平台下已存在相同 App ID", 409);
    throw error;
  }
}

export async function updateIntegrationApplication(id: string, input: {
  name: unknown;
  appId: unknown;
  note?: unknown;
  appSecret?: unknown;
  actionIds?: unknown;
}) {
  await ensureSchema();
  const safeId = requiredUuid(id);
  const current = await getPool().query<IntegrationApplicationRow>(`
    SELECT id, platform, app_name, app_id, note, action_ids, active, created_at, updated_at
    FROM integration_applications
    WHERE id = $1
  `, [safeId]);
  if (!current.rows[0]) throw new IntegrationStoreError("应用配置不存在", 404);
  const name = requiredValue(input.name, "应用名称", APP_NAME_MAX_LENGTH);
  const appId = requiredValue(input.appId, "App ID", APP_ID_MAX_LENGTH);
  const note = optionalValue(input.note, "备注", APP_NOTE_MAX_LENGTH);
  const appSecret = optionalSecret(input.appSecret);
  const actionIds = await normalizeIntegrationActionIds(
    current.rows[0].platform,
    input.actionIds,
    storedActionIds(current.rows[0].action_ids),
  );
  const parameters = appSecret
    ? [safeId, name, appId, note, JSON.stringify(actionIds), encryptIntegrationSecret(appSecret)]
    : [safeId, name, appId, note, JSON.stringify(actionIds)];
  const secretAssignment = appSecret ? ", app_secret_ciphertext = $6" : "";
  try {
    const result = await getPool().query<IntegrationApplicationRow>(`
      UPDATE integration_applications
      SET app_name = $2, app_id = $3, note = $4, action_ids = $5::JSONB${secretAssignment}, updated_at = NOW()
      WHERE id = $1
      RETURNING id, platform, app_name, app_id, note, action_ids, active, created_at, updated_at
    `, parameters);
    if (!result.rows[0]) throw new IntegrationStoreError("应用配置不存在", 404);
    return serializeApplication(result.rows[0]);
  } catch (error) {
    if (isUniqueViolation(error)) throw new IntegrationStoreError("该平台下已存在相同 App ID", 409);
    throw error;
  }
}

export async function deleteIntegrationApplication(id: string) {
  await ensureSchema();
  try {
    const result = await getPool().query(
      "DELETE FROM integration_applications WHERE id = $1",
      [requiredUuid(id)],
    );
    if (!result.rowCount) throw new IntegrationStoreError("应用配置不存在", 404);
    return { deleted: true };
  } catch (error) {
    if (isForeignKeyViolation(error)) {
      throw new IntegrationStoreError("该应用仍有员工账号绑定，不能删除", 409);
    }
    throw error;
  }
}

async function applicationWithSecret(id: string) {
  const result = await getPool().query<IntegrationApplicationRow>(`
    SELECT id, platform, app_name, app_id, note, action_ids, active, app_secret_ciphertext, created_at, updated_at
    FROM integration_applications
    WHERE id = $1
  `, [requiredUuid(id)]);
  const row = result.rows[0];
  if (!row?.app_secret_ciphertext) throw new IntegrationStoreError("应用配置不存在", 404);
  return row;
}

export type ActiveIntegrationCredential = {
  id: string;
  platform: EnterpriseIntegrationPlatform;
  name: string;
  appId: string;
  appSecret: string;
  updatedAt: string;
};

export async function getActiveIntegrationCredential(
  platform: EnterpriseIntegrationPlatform,
): Promise<ActiveIntegrationCredential> {
  await ensureSchema();
  const safePlatform = normalizePlatform(platform);
  const result = await getPool().query<IntegrationApplicationRow>(`
    SELECT id, platform, app_name, app_id, note, action_ids, active,
           app_secret_ciphertext, created_at, updated_at
    FROM integration_applications
    WHERE platform = $1 AND active
    LIMIT 1
  `, [safePlatform]);
  const row = result.rows[0];
  if (!row?.app_secret_ciphertext) {
    throw new IntegrationStoreError(`${platformDefinition(safePlatform).displayName}尚未启用应用配置`, 404);
  }
  return {
    id: row.id,
    platform: row.platform,
    name: row.app_name,
    appId: row.app_id,
    appSecret: decryptIntegrationSecret(row.app_secret_ciphertext),
    updatedAt: new Date(row.updated_at).toISOString(),
  };
}

async function syncApplicationOAuthClient(row: IntegrationApplicationRow) {
  const definition = platformDefinitions.find((item) => item.platform === row.platform);
  if (!definition?.service || definition.bindingMode !== "oauth2" || !row.app_secret_ciphertext) return;
  await saveConnectorOAuthConfig(definition.service, {
    clientId: row.app_id,
    clientSecret: decryptIntegrationSecret(row.app_secret_ciphertext),
    extra: {},
    secretExtra: {},
  });
}

export async function activateIntegrationApplication(id: string) {
  await ensureSchema();
  const row = await applicationWithSecret(id);
  if (!row.active) {
    const binding = await getPool().query(`
      SELECT 1
      FROM employee_connector_bindings
      WHERE platform = $1 AND status IN ('pending', 'connected')
      LIMIT 1
    `, [row.platform]);
    if (binding.rowCount) {
      throw new IntegrationStoreError("该平台已有员工账号绑定，不能切换启用应用", 409);
    }
  }

  await syncApplicationOAuthClient(row);
  const client = await getPool().connect();
  try {
    await client.query("BEGIN");
    await client.query(
      "UPDATE integration_applications SET active = FALSE, updated_at = NOW() WHERE platform = $1 AND id <> $2",
      [row.platform, row.id],
    );
    const result = await client.query<IntegrationApplicationRow>(`
      UPDATE integration_applications
      SET active = TRUE, updated_at = NOW()
      WHERE id = $1
      RETURNING id, platform, app_name, app_id, note, action_ids, active, created_at, updated_at
    `, [row.id]);
    await client.query("COMMIT");
    return serializeApplication(result.rows[0]);
  } catch (error) {
    await client.query("ROLLBACK");
    throw error;
  } finally {
    client.release();
  }
}

function serializeBinding(row: EmployeeConnectorBindingRow): EmployeeConnectorBinding {
  return {
    id: row.id,
    ...(row.application_id ? { applicationId: row.application_id } : {}),
    platform: row.platform,
    service: row.service,
    connectionName: row.connection_name,
    status: row.status,
    displayName: row.display_name || undefined,
    accountId: row.account_id || undefined,
    errorMessage: row.error_message || undefined,
    connectedAt: row.connected_at ? new Date(row.connected_at).toISOString() : undefined,
    updatedAt: new Date(row.updated_at).toISOString(),
  };
}

function employeeConnectionName(identity: ConsoleIdentity, service: string, discriminator = "") {
  const material = discriminator
    ? `${identity.principalIssuer}\0${identity.principalSubject}\0${service}\0${discriminator}`
    : `${identity.principalIssuer}\0${identity.principalSubject}\0${service}`;
  const digest = createHash("sha256")
    .update(material, "utf8")
    .digest("hex")
    .slice(0, 40);
  return `usr_${digest}`;
}

async function reconcileEmployeeBindings(identity: ConsoleIdentity) {
  let rows = await getPool().query<EmployeeConnectorBindingRow>(`
    SELECT id, application_id, platform, service, connection_name, status,
           display_name, account_id, error_message, connected_at, updated_at
    FROM employee_connector_bindings
    WHERE principal_issuer = $1 AND principal_subject = $2 AND status <> 'revoked'
  `, [identity.principalIssuer, identity.principalSubject]);
  if (!rows.rowCount) {
    const legacy = await getPool().query<EmployeeConnectorBindingRow>(`
      SELECT id, application_id, platform, service, connection_name, status,
             display_name, account_id, error_message, connected_at, updated_at
      FROM employee_connector_bindings
      WHERE principal_issuer = $1 AND LOWER(principal_email) = $2 AND status <> 'revoked'
      ORDER BY service, updated_at DESC
    `, [identity.principalIssuer, identity.email]);
    const services = new Set<string>();
    for (const row of legacy.rows) {
      if (services.has(row.service) && row.platform !== "wecom_bot") {
        throw new IntegrationStoreError("当前邮箱存在冲突的历史 Connector 绑定", 409);
      }
      services.add(row.service);
    }
    if (legacy.rowCount) {
      await getPool().query(`
        UPDATE employee_connector_bindings
        SET principal_subject = $3, principal_email = $4, principal_name = $5, updated_at = NOW()
        WHERE principal_issuer = $1 AND LOWER(principal_email) = $2 AND status <> 'revoked'
      `, [
        identity.principalIssuer,
        identity.email,
        identity.principalSubject,
        identity.email,
        identity.name,
      ]);
      rows = await getPool().query<EmployeeConnectorBindingRow>(`
        SELECT id, application_id, platform, service, connection_name, status,
               display_name, account_id, error_message, connected_at, updated_at
        FROM employee_connector_bindings
        WHERE principal_issuer = $1 AND principal_subject = $2 AND status <> 'revoked'
      `, [identity.principalIssuer, identity.principalSubject]);
    }
  }
  if (!rows.rowCount) return [];

  const snapshot = await listConnectorConnections();
  const connections = new Map(
    snapshot.connections
      .filter((connection) => connection.configured)
      .map((connection) => [`${connection.service}\0${connection.connectionName}`, connection]),
  );

  for (const row of rows.rows) {
    const connection = connections.get(`${row.service}\0${row.connection_name}`);
    if (connection && row.status !== "connected") {
      await getPool().query(`
        UPDATE employee_connector_bindings
        SET status = 'connected', display_name = $2, account_id = $3,
            error_message = NULL, connected_at = COALESCE(connected_at, NOW()), updated_at = NOW()
        WHERE id = $1
      `, [row.id, connection.profile.displayName, connection.profile.accountId]);
    } else if (!connection && row.status === "connected") {
      await getPool().query(`
        UPDATE employee_connector_bindings
        SET status = 'revoked', error_message = 'OpenConnector 中的个人连接已不存在', updated_at = NOW()
        WHERE id = $1
      `, [row.id]);
    }
  }

  const refreshed = await getPool().query<EmployeeConnectorBindingRow>(`
    SELECT id, application_id, platform, service, connection_name, status,
           display_name, account_id, error_message, connected_at, updated_at
    FROM employee_connector_bindings
    WHERE principal_issuer = $1 AND principal_subject = $2 AND status <> 'revoked'
  `, [identity.principalIssuer, identity.principalSubject]);
  return refreshed.rows;
}

export async function getEmployeeIntegrations(identity: ConsoleIdentity): Promise<EmployeeIntegrationsSnapshot> {
  await ensureSchema();
  await migrateLegacyWeComBotIntegrations();
  const [applications, bindings, wecomIdentity] = await Promise.all([
    getPool().query<IntegrationApplicationRow>(`
      SELECT id, platform, app_name, app_id, note, action_ids, active, created_at, updated_at
      FROM integration_applications
      ORDER BY created_at, app_name, app_id
    `),
    reconcileEmployeeBindings(identity),
    getWeComIdentityLinkSnapshot(identity),
  ]);
  const resolved = await resolveEmployeeConnectorBindings({
    issuer: identity.principalIssuer,
    subject: identity.principalSubject,
    email: identity.email,
    groups: identity.groups,
  });
  const identityScopedConnections: EmployeeResolvedConnection[] = "connections" in resolved
    ? resolved.connections.flatMap((connection) => {
      if (connection.accessMode !== "account_bound" && connection.accessMode !== "controlled_shared") return [];
      return [{
        service: connection.service,
        connectionName: connection.connectionName,
        displayName: connection.displayName,
        accessMode: connection.accessMode,
        allowedActionIds: "allowedActionIds" in connection && Array.isArray(connection.allowedActionIds)
          ? connection.allowedActionIds.filter((actionId): actionId is string => typeof actionId === "string")
          : undefined,
        policyIds: "policyIds" in connection && Array.isArray(connection.policyIds)
          ? connection.policyIds.filter((policyId): policyId is string => typeof policyId === "string")
          : undefined,
      }];
    })
    : [];
  const services = Array.from(new Set(identityScopedConnections.map((connection) => connection.service)));
  const providers = (await Promise.all(services.map(async (service) => {
    try {
      return await getConnectorProvider(service);
    } catch {
      return undefined;
    }
  }))).filter((provider): provider is ConnectorProviderDetail => Boolean(provider));
  const availableConnections = buildEmployeeAvailableConnections(identityScopedConnections, providers);
  const automaticWeComBotCount = availableConnections.filter((connection) => (
    connection.service === "wecom_bot"
      && connection.authorizationSources.includes("wecom_visibility")
  )).length;
  return buildEmployeeIntegrationsSnapshot(
    applications.rows.map(serializeApplication),
    bindings.map(serializeBinding),
    { name: identity.name, email: identity.email },
    undefined,
    automaticWeComBotCount,
    wecomIdentity,
    availableConnections,
  );
}

export async function listClassifiedConnectorConnections(): Promise<ConnectorConnectionsSnapshot> {
  await ensureSchema();
  await migrateLegacyWeComBotIntegrations();
  const [snapshot, bindings, sharedResources] = await Promise.all([
    listConnectorConnections(),
    getPool().query<Pick<
      EmployeeConnectorBindingRow,
      "service" | "connection_name" | "principal_email" | "principal_name" | "display_name"
    >>(`
      SELECT service, connection_name, principal_email, principal_name, display_name
      FROM employee_connector_bindings
      WHERE status <> 'revoked'
    `),
    getPool().query<{
      id: string;
      service: string;
      connection_name: string;
      display_name: string;
      security_domain: string;
      authorization_mode: "manual" | "wecom_visibility";
      wecom_organization_id: string | null;
      wecom_organization_name: string | null;
      action_ids: unknown;
      enabled: boolean;
      grant_count: string;
    }>(`
      SELECT resource.id, resource.service, resource.connection_name,
             resource.display_name, resource.security_domain,
             resource.authorization_mode, resource.wecom_organization_id,
             organization.organization_name AS wecom_organization_name,
             resource.action_ids, resource.enabled,
             COUNT(grant_row.id)::TEXT AS grant_count
      FROM shared_connector_resources AS resource
      LEFT JOIN shared_connector_grants AS grant_row
        ON grant_row.resource_id = resource.id AND grant_row.enabled
      LEFT JOIN wecom_authentication_organizations AS organization
        ON organization.id = resource.wecom_organization_id
      GROUP BY resource.id, organization.organization_name
    `),
  ]);
  const localAccountsByConnectionKey = new Map(
    bindings.rows.map((binding) => [
      connectorConnectionKey(binding.service, binding.connection_name),
      {
        name: binding.principal_name,
        email: binding.principal_email,
      },
    ]),
  );
  const personalDisplayNamesByConnectionKey = new Map(
    bindings.rows.flatMap((binding) => binding.display_name
      ? [[connectorConnectionKey(binding.service, binding.connection_name), binding.display_name] as const]
      : []),
  );
  const sharedAccessByConnectionKey = new Map(
    sharedResources.rows.map((resource) => [
      connectorConnectionKey(resource.service, resource.connection_name),
      {
        resourceId: resource.id,
        displayName: resource.display_name,
        securityDomain: resource.security_domain,
        authorizationMode: resource.authorization_mode,
        wecomOrganizationId: resource.wecom_organization_id,
        wecomOrganizationName: resource.wecom_organization_name,
        actionCount: storedActionIds(resource.action_ids).length,
        enabled: resource.enabled,
        grantCount: Number.parseInt(resource.grant_count, 10) || 0,
      },
    ]),
  );
  const classifiedConnections = classifyConnectorConnections(
    snapshot.connections,
    localAccountsByConnectionKey,
    sharedAccessByConnectionKey,
  );
  return {
    ...snapshot,
    connections: classifiedConnections.map((connection) => {
      const displayName = connection.accessMode === "account_bound"
        ? personalDisplayNamesByConnectionKey.get(connectorConnectionKey(connection.service, connection.connectionName))
        : undefined;
      return displayName
        ? { ...connection, profile: { ...connection.profile, displayName } }
        : connection;
    }),
  };
}

export function buildEmployeeIntegrationsSnapshot(
  applications: IntegrationApplication[],
  bindings: EmployeeConnectorBinding[],
  identity: EmployeeIntegrationsSnapshot["identity"],
  updatedAt = new Date().toISOString(),
  automaticWeComBotCount = applications.filter((application) => application.platform === "wecom_bot" && application.active).length,
  wecomIdentity: EmployeeIntegrationsSnapshot["wecomIdentity"] = { linked: false, identities: [] },
  availableConnections: EmployeeAvailableConnection[] = [],
): EmployeeIntegrationsSnapshot {
  const bindingByApplication = new Map(
    bindings.map((binding) => [binding.applicationId, binding]),
  );
  const employeeApplications: EmployeeIntegrationApplication[] = platformDefinitions.flatMap(
    (definition) => applications
      .filter((application) => application.platform === definition.platform)
      .map((application) => ({
        id: application.id,
        platform: application.platform,
        name: application.name,
        appId: application.appId,
        note: application.note,
        active: application.active,
        platformDisplayName: definition.displayName,
        bindingMode: definition.bindingMode,
        binding: bindingByApplication.get(application.id),
      })),
  );
  return {
    identity,
    wecomIdentity,
    applications: employeeApplications,
    availableConnections,
    automaticWeComBotCount,
    updatedAt,
  };
}

type EmployeeResolvedConnection = {
  service: string;
  connectionName: string;
  displayName: string;
  accessMode: "account_bound" | "controlled_shared";
  allowedActionIds?: string[];
  policyIds?: string[];
};

export function buildEmployeeAvailableConnections(
  connections: EmployeeResolvedConnection[],
  providers: Array<Pick<ConnectorProviderDetail, "service" | "displayName" | "actions">>,
): EmployeeAvailableConnection[] {
  const providersByService = new Map(providers.map((provider) => [provider.service, provider]));
  const merged = new Map<string, {
    connection: EmployeeResolvedConnection;
    actionIds: Set<string>;
    sources: Set<EmployeeAvailableConnection["authorizationSources"][number]>;
  }>();

  for (const connection of connections) {
    const key = connectorConnectionKey(connection.service, connection.connectionName);
    const current = merged.get(key) || {
      connection,
      actionIds: new Set<string>(),
      sources: new Set<EmployeeAvailableConnection["authorizationSources"][number]>(),
    };
    for (const actionId of connection.allowedActionIds || []) current.actionIds.add(actionId);
    if (connection.accessMode === "account_bound") {
      current.sources.add("personal");
    } else {
      const policyIds = connection.policyIds || [];
      if (policyIds.some((policyId) => policyId.startsWith("wecom-visibility:"))) {
        current.sources.add("wecom_visibility");
      }
      if (!policyIds.length || policyIds.some((policyId) => !policyId.startsWith("wecom-visibility:"))) {
        current.sources.add("manual");
      }
    }
    merged.set(key, current);
  }

  return Array.from(merged.values()).map(({ connection, actionIds, sources }) => {
    const provider = providersByService.get(connection.service);
    const actionsById = new Map((provider?.actions || []).map((action) => [action.id, action]));
    return {
      id: `${connection.service}:${connection.connectionName}`,
      service: connection.service,
      serviceDisplayName: provider?.displayName || connection.service,
      connectionName: connection.connectionName,
      displayName: connection.displayName || provider?.displayName || connection.connectionName,
      accessMode: connection.accessMode,
      authorizationSources: Array.from(sources),
      actions: Array.from(actionIds).sort().map((actionId) => {
        const action = actionsById.get(actionId);
        return {
          id: actionId,
          name: action?.name || actionId.split(".").at(-1) || actionId,
          ...(action?.description ? { description: action.description } : {}),
        };
      }),
    };
  }).filter((connection) => connection.actions.length > 0).sort((left, right) => (
    left.displayName.localeCompare(right.displayName, "zh-CN")
      || left.service.localeCompare(right.service)
      || left.connectionName.localeCompare(right.connectionName)
  ));
}

function platformDefinition(platform: string) {
  const definition = platformDefinitions.find((item) => item.platform === platform);
  if (!definition) throw new IntegrationStoreError("不支持的集成平台", 400);
  return definition;
}

export async function startEmployeeIntegrationAuthorization(
  identity: ConsoleIdentity,
  applicationId: string,
) {
  await ensureSchema();
  const row = await applicationWithSecret(applicationId);
  const definition = platformDefinition(row.platform);
  if (definition.bindingMode === "unsupported" || !definition.service) {
    throw new IntegrationStoreError("当前集成类型暂不支持员工账号绑定", 409);
  }
  if (!row.active) {
    throw new IntegrationStoreError("管理员尚未启用该应用配置", 409);
  }

  const actionIds = await normalizeIntegrationActionIds(
    row.platform,
    row.action_ids,
    platformDefinition(row.platform).defaultActionIds,
  );
  const connectionName = employeeConnectionName(identity, definition.service);
  const bindingId = randomUUID();
  await getPool().query(`
    INSERT INTO employee_connector_bindings (
      id, application_id, principal_issuer, principal_subject, principal_email,
      principal_name, platform, service, connection_name, status
    )
    VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, 'pending')
    ON CONFLICT (principal_issuer, principal_subject, service)
      WHERE application_id IS NOT NULL
    DO UPDATE SET
      application_id = EXCLUDED.application_id,
      principal_email = EXCLUDED.principal_email,
      principal_name = EXCLUDED.principal_name,
      platform = EXCLUDED.platform,
      connection_name = EXCLUDED.connection_name,
      status = 'pending',
      display_name = NULL,
      account_id = NULL,
      error_message = NULL,
      connected_at = NULL,
      updated_at = NOW()
  `, [
    bindingId,
    row.id,
    identity.principalIssuer,
    identity.principalSubject,
    identity.email,
    identity.name,
    definition.platform,
    definition.service,
    connectionName,
  ]);

  try {
    await syncApplicationOAuthClient(row);
    return await startConnectorOAuthAuthorization(definition.service, connectionName, actionIds);
  } catch (error) {
    await getPool().query(`
      UPDATE employee_connector_bindings
      SET status = 'error', error_message = $3, updated_at = NOW()
      WHERE principal_issuer = $1 AND principal_subject = $2 AND service = $4
    `, [
      identity.principalIssuer,
      identity.principalSubject,
      error instanceof Error ? error.message : "无法完成员工账号绑定",
      definition.service,
    ]);
    throw error;
  }
}

export async function disconnectEmployeeIntegration(identity: ConsoleIdentity, applicationId: string) {
  await ensureSchema();
  const safeApplicationId = requiredUuid(applicationId);
  const result = await getPool().query<EmployeeConnectorBindingRow>(`
    SELECT id, application_id, platform, service, connection_name, status,
           display_name, account_id, error_message, connected_at, updated_at
    FROM employee_connector_bindings
    WHERE principal_issuer = $1 AND principal_subject = $2
      AND application_id = $3 AND status <> 'revoked'
  `, [identity.principalIssuer, identity.principalSubject, safeApplicationId]);
  const binding = result.rows[0];
  if (!binding) throw new IntegrationStoreError("个人账号尚未绑定", 404);
  await deleteConnectorConnection(binding.service, binding.connection_name);
  await getPool().query(`
    UPDATE employee_connector_bindings
    SET status = 'revoked', error_message = NULL, updated_at = NOW()
    WHERE id = $1
  `, [binding.id]);
  return { disconnected: true };
}

const WECOM_BOT_AUTHORIZATION_REQUEST_PATTERN = /^[A-Za-z0-9_-]{43}$/;
const CONNECTOR_CONNECTION_NAME_PATTERN = /^[a-zA-Z0-9][a-zA-Z0-9_-]{0,127}$/;
const WECOM_BOT_VISIBILITY_RETRY_DELAYS_MS = [0, 750, 1_500, 3_000, 5_000] as const;
const WECOM_BOT_TRANSIENT_VISIBILITY_STATUSES = new Set([403, 409]);

function hashOpaqueValue(value: string) {
  return createHash("sha256").update(value, "utf8").digest("hex");
}

function weComBotCredentialFingerprint(botId: string) {
  return hashOpaqueValue(`wecom_bot\0${botId}`);
}

export async function readWeComBotVisibleUserIdsWithRetry(
  run: () => Promise<unknown>,
  retryDelaysMs: readonly number[] = WECOM_BOT_VISIBILITY_RETRY_DELAYS_MS,
  wait: (delayMs: number) => Promise<void> = (delayMs) => new Promise((resolve) => setTimeout(resolve, delayMs)),
) {
  const users = await readWeComBotVisibleUsersWithRetry(run, retryDelaysMs, wait);
  return new Set(users.map((user) => user.userIdHash));
}

export async function readWeComBotVisibleUsersWithRetry(
  run: () => Promise<unknown>,
  retryDelaysMs: readonly number[] = WECOM_BOT_VISIBILITY_RETRY_DELAYS_MS,
  wait: (delayMs: number) => Promise<void> = (delayMs) => new Promise((resolve) => setTimeout(resolve, delayMs)),
) {
  let lastError: unknown;
  for (const delayMs of retryDelaysMs) {
    if (delayMs > 0) await wait(delayMs);
    try {
      return parseWeComVisibleUsers(await run());
    } catch (error) {
      lastError = error;
      if (!(error instanceof OpenConnectorError) || !WECOM_BOT_TRANSIENT_VISIBILITY_STATUSES.has(error.status)) {
        throw error;
      }
    }
  }
  throw lastError;
}

export function personalWeComBotDisplayName(input: {
  binderName?: string;
  connectionName: string;
}) {
  const suffix = input.connectionName.slice(-4);
  const ending = `绑定的企微机器人 · ${suffix}`;
  const binderName = input.binderName?.trim() || "当前用户";
  return `${binderName.slice(0, Math.max(1, 120 - ending.length))}${ending}`;
}

export function parseWeComBotPersonalActionIds(
  value: unknown,
  actions: ConnectorProviderDetail["actions"],
) {
  const payload = recordValue(value);
  const toolNames = new Set<string>();
  for (const categoryValue of Array.isArray(payload?.categories) ? payload.categories : []) {
    const category = recordValue(categoryValue);
    for (const toolValue of Array.isArray(category?.tools) ? category.tools : []) {
      const tool = recordValue(toolValue);
      if (typeof tool?.name === "string" && tool.name.trim()) toolNames.add(tool.name.trim());
    }
  }
  return actions.flatMap((action) => {
    if (action.execution?.catalogOnly === true || WECOM_BOT_SYSTEM_ONLY_ACTION_IDS.has(action.id)) return [];
    const actionName = action.id.split(".").at(-1) || action.name;
    if (!WECOM_BOT_PERSONAL_READ_ACTION_NAMES.has(actionName)) return [];
    const toolName = actionName === "download_message_media" ? "get_msg_media" : actionName;
    return actionName === "list_tools" || toolNames.has(toolName) ? [action.id] : [];
  }).sort();
}

export async function startEmployeeWeComBotAuthorization(identity: ConsoleIdentity) {
  await ensureSchema();
  if (!(await getLinkedWeComIdentityClaims(identity.principalIssuer, identity.principalSubject)).length) {
    throw new IntegrationStoreError("请先完成企业微信身份认证", 409);
  }
  const session = await createWeComBotQrSession();
  const request = randomBytes(32).toString("base64url");
  await getPool().query(`
    DELETE FROM wecom_bot_authorization_requests
    WHERE expires_at < NOW() - INTERVAL '1 day'
  `);
  await getPool().query(`
    INSERT INTO wecom_bot_authorization_requests (
      request_hash, scode, principal_issuer, principal_subject, expires_at
    ) VALUES ($1, $2, $3, $4, $5)
  `, [
    hashOpaqueValue(request),
    session.scode,
    identity.principalIssuer,
    identity.principalSubject,
    session.expiresAt,
  ]);
  return {
    request,
    pageUrl: session.pageUrl,
    expiresAt: session.expiresAt,
  };
}

async function connectEmployeeWeComBot(
  identity: ConsoleIdentity,
  botId: string,
  secret: string,
) {
  const linkedIdentity = await getLinkedWeComIdentityClaims(identity.principalIssuer, identity.principalSubject);
  if (!linkedIdentity.length) throw new IntegrationStoreError("企业微信身份认证已失效", 409);
  const credentialFingerprint = weComBotCredentialFingerprint(botId);
  const existingFingerprint = await getPool().query<Pick<
    EmployeeConnectorBindingRow,
    "principal_issuer" | "principal_subject" | "connection_name"
  >>(`
    SELECT principal_issuer, principal_subject, connection_name
    FROM employee_connector_bindings
    WHERE credential_fingerprint = $1 AND status <> 'revoked'
    LIMIT 1
  `, [credentialFingerprint]);
  const existingOwner = existingFingerprint.rows[0];
  if (existingOwner && (
    existingOwner.principal_issuer !== identity.principalIssuer
    || existingOwner.principal_subject !== identity.principalSubject
  )) {
    throw new IntegrationStoreError("该企业微信机器人已绑定到其他平台账号", 409);
  }

  const connectionName = existingOwner?.connection_name
    || employeeConnectionName(identity, "wecom_bot", credentialFingerprint);
  const existingBinding = await getPool().query<Pick<
    EmployeeConnectorBindingRow,
    "principal_issuer" | "principal_subject"
  >>(`
    SELECT principal_issuer, principal_subject
    FROM employee_connector_bindings
    WHERE service = 'wecom_bot' AND connection_name = $1
    LIMIT 1
  `, [connectionName]);
  const connectionOwner = existingBinding.rows[0];
  if (connectionOwner && (
    connectionOwner.principal_issuer !== identity.principalIssuer
    || connectionOwner.principal_subject !== identity.principalSubject
  )) {
    throw new IntegrationStoreError("机器人连接名称已被其他账号占用", 409);
  }

  const [provider, connectionSnapshot] = await Promise.all([
    getConnectorProvider("wecom_bot"),
    listConnectorConnections(),
  ]);
  const connectionPreviouslyExisted = connectionSnapshot.connections.some((connection) => (
    connection.service === "wecom_bot" && connection.connectionName === connectionName
  ));
  const validationConnectionName = `tmp_wecom_${randomBytes(12).toString("hex")}`;
  let canonicalConnectionSaved = false;
  try {
    await bootstrapWeComBotQrCredential(botId, secret);
    const validationConnection = await saveConnectorConnection("wecom_bot", {
      connectionName: validationConnectionName,
      authType: "custom_credential",
      values: { botId, secret },
    });
    if (!validationConnection?.configured) {
      throw new IntegrationStoreError("企业微信机器人连接校验失败", 502);
    }

    const visibleUsers = await readWeComBotVisibleUsersWithRetry(
      () => runConnectorAction("wecom_bot.get_userlist", validationConnectionName),
    );
    const linkedUserHashes = new Set(linkedIdentity.map((candidate) => candidate.userIdHash));
    const bindingUser = visibleUsers.find((user) => linkedUserHashes.has(user.userIdHash));
    if (!bindingUser) {
      throw new IntegrationStoreError("新机器人未包含当前已认证企业微信用户，请调整可使用成员后重试", 403);
    }
    const toolCatalogs = (await Promise.all(WECOM_BOT_TOOL_CATEGORIES.map(async (category) => {
      try {
        return await runConnectorAction("wecom_bot.list_tools", validationConnectionName, { category });
      } catch {
        return undefined;
      }
    }))).flatMap((catalog) => {
      const categories = recordValue(catalog)?.categories;
      return Array.isArray(categories) ? categories : [];
    });
    toolCatalogs.push({ category: "contact", tools: [{ name: "get_userlist" }] });
    const actionIds = parseWeComBotPersonalActionIds({ categories: toolCatalogs }, provider.actions);
    if (!actionIds.includes("wecom_bot.get_userlist")) {
      throw new IntegrationStoreError("新机器人没有可验证的通讯录读取权限", 409);
    }
    const connection = await saveConnectorConnection("wecom_bot", {
      connectionName,
      authType: "custom_credential",
      values: { botId, secret },
    });
    if (!connection?.configured) {
      throw new IntegrationStoreError("企业微信机器人连接创建失败", 502);
    }
    canonicalConnectionSaved = true;
    const displayName = personalWeComBotDisplayName({
      binderName: bindingUser.name || identity.name,
      connectionName,
    });

    const result = await getPool().query(`
      INSERT INTO employee_connector_bindings (
        id, application_id, principal_issuer, principal_subject, principal_email,
        principal_name, platform, service, connection_name, status, display_name,
        account_id, action_ids, credential_fingerprint, connected_at
      ) VALUES (
        $1, NULL, $2, $3, $4, $5, 'wecom_bot', 'wecom_bot', $6, 'connected',
        $7, $8, $9::JSONB, $10, NOW()
      )
      ON CONFLICT (service, connection_name) DO UPDATE SET
        principal_email = EXCLUDED.principal_email,
        principal_name = EXCLUDED.principal_name,
        status = 'connected',
        display_name = EXCLUDED.display_name,
        account_id = EXCLUDED.account_id,
        action_ids = EXCLUDED.action_ids,
        credential_fingerprint = EXCLUDED.credential_fingerprint,
        error_message = NULL,
        connected_at = COALESCE(employee_connector_bindings.connected_at, NOW()),
        updated_at = NOW()
      WHERE employee_connector_bindings.principal_issuer = EXCLUDED.principal_issuer
        AND employee_connector_bindings.principal_subject = EXCLUDED.principal_subject
      RETURNING connection_name
    `, [
      randomUUID(),
      identity.principalIssuer,
      identity.principalSubject,
      identity.email,
      identity.name,
      connectionName,
      displayName,
      connection.profile.accountId,
      JSON.stringify(actionIds),
      credentialFingerprint,
    ]);
    if (!result.rowCount) throw new IntegrationStoreError("企业微信机器人连接归属冲突", 409);
    return { connectionName };
  } catch (error) {
    if (canonicalConnectionSaved && !connectionPreviouslyExisted) {
      await deleteConnectorConnection("wecom_bot", connectionName).catch(() => undefined);
    }
    if ((error as { code?: string })?.code === "23505") {
      throw new IntegrationStoreError("该企业微信机器人已绑定到其他平台账号", 409);
    }
    if (error instanceof OpenConnectorError) {
      throw new IntegrationStoreError("企业微信机器人连接校验失败", 502);
    }
    throw error;
  } finally {
    await deleteConnectorConnection("wecom_bot", validationConnectionName).catch(() => undefined);
  }
}

export async function pollEmployeeWeComBotAuthorization(identity: ConsoleIdentity, request: string) {
  await ensureSchema();
  if (!WECOM_BOT_AUTHORIZATION_REQUEST_PATTERN.test(request)) {
    throw new IntegrationStoreError("企业微信机器人扫码请求无效", 400);
  }
  const requestHash = hashOpaqueValue(request);
  const result = await getPool().query<WeComBotAuthorizationRequestRow>(`
    SELECT request_hash, scode, principal_issuer, principal_subject, expires_at,
           processing_at, completed_at, connection_name
    FROM wecom_bot_authorization_requests
    WHERE request_hash = $1 AND principal_issuer = $2 AND principal_subject = $3
    LIMIT 1
  `, [requestHash, identity.principalIssuer, identity.principalSubject]);
  const row = result.rows[0];
  if (!row) throw new IntegrationStoreError("企业微信机器人扫码请求不存在", 404);
  if (row.completed_at && row.connection_name) {
    return { status: "connected" as const, connectionName: row.connection_name };
  }
  if (new Date(row.expires_at).getTime() <= Date.now()) {
    await getPool().query(`
      UPDATE wecom_bot_authorization_requests
      SET scode = NULL, processing_at = NULL
      WHERE request_hash = $1 AND completed_at IS NULL
    `, [requestHash]);
    throw new IntegrationStoreError("企业微信机器人二维码已过期，请重新生成", 410);
  }
  if (!row.scode) throw new IntegrationStoreError("企业微信机器人扫码请求已失效", 410);

  const polled = await pollWeComBotQrSession(row.scode);
  if (polled.status === "pending") return { status: "pending" as const };
  const claim = await getPool().query(`
    UPDATE wecom_bot_authorization_requests
    SET processing_at = NOW()
    WHERE request_hash = $1 AND completed_at IS NULL
      AND (processing_at IS NULL OR processing_at < NOW() - INTERVAL '45 seconds')
    RETURNING request_hash
  `, [requestHash]);
  if (!claim.rowCount) return { status: "pending" as const };

  try {
    const connected = await connectEmployeeWeComBot(identity, polled.botId, polled.secret);
    await getPool().query(`
      UPDATE wecom_bot_authorization_requests
      SET completed_at = NOW(), connection_name = $2, processing_at = NULL, scode = NULL
      WHERE request_hash = $1
    `, [requestHash, connected.connectionName]);
    return { status: "connected" as const, connectionName: connected.connectionName };
  } catch (error) {
    await getPool().query(`
      UPDATE wecom_bot_authorization_requests
      SET processing_at = NULL
      WHERE request_hash = $1 AND completed_at IS NULL
    `, [requestHash]).catch(() => undefined);
    throw error;
  }
}

export async function disconnectEmployeeWeComBot(identity: ConsoleIdentity, connectionName: string) {
  await ensureSchema();
  const safeConnectionName = connectionName.trim();
  if (!CONNECTOR_CONNECTION_NAME_PATTERN.test(safeConnectionName)) {
    throw new IntegrationStoreError("企业微信机器人连接名称无效", 400);
  }
  const result = await getPool().query<Pick<EmployeeConnectorBindingRow, "id">>(`
    SELECT id
    FROM employee_connector_bindings
    WHERE principal_issuer = $1 AND principal_subject = $2
      AND platform = 'wecom_bot' AND service = 'wecom_bot'
      AND application_id IS NULL AND connection_name = $3
      AND status <> 'revoked'
    LIMIT 1
  `, [identity.principalIssuer, identity.principalSubject, safeConnectionName]);
  const binding = result.rows[0];
  if (!binding) throw new IntegrationStoreError("个人企业微信机器人连接不存在", 404);

  try {
    await deleteConnectorConnection("wecom_bot", safeConnectionName);
  } catch (error) {
    if (!(error instanceof OpenConnectorError) || error.status !== 404) throw error;
  }
  await getPool().query(`
    UPDATE employee_connector_bindings
    SET status = 'revoked', error_message = NULL, updated_at = NOW()
    WHERE id = $1
      AND principal_issuer = $2 AND principal_subject = $3
      AND status <> 'revoked'
  `, [binding.id, identity.principalIssuer, identity.principalSubject]);
  return { disconnected: true as const };
}

export async function renameEmployeeWeComBot(
  identity: ConsoleIdentity,
  connectionName: string,
  displayName: string,
) {
  await ensureSchema();
  const safeConnectionName = connectionName.trim();
  if (!CONNECTOR_CONNECTION_NAME_PATTERN.test(safeConnectionName)) {
    throw new IntegrationStoreError("企业微信机器人连接名称无效", 400);
  }
  const safeDisplayName = typeof displayName === "string" ? displayName.trim() : "";
  if (!safeDisplayName) throw new IntegrationStoreError("请输入连接名称", 400);
  if (safeDisplayName.length > 120) throw new IntegrationStoreError("连接名称不能超过 120 个字符", 400);

  const result = await getPool().query(`
    UPDATE employee_connector_bindings
    SET display_name = $4, updated_at = NOW()
    WHERE principal_issuer = $1 AND principal_subject = $2
      AND platform = 'wecom_bot' AND service = 'wecom_bot'
      AND application_id IS NULL AND connection_name = $3
      AND status = 'connected'
  `, [
    identity.principalIssuer,
    identity.principalSubject,
    safeConnectionName,
    safeDisplayName,
  ]);
  if (!result.rowCount) throw new IntegrationStoreError("个人企业微信机器人连接不存在", 404);
  return { renamed: true as const, displayName: safeDisplayName };
}

const WECOM_VISIBILITY_CACHE_TTL_MS = 60_000;
const WECOM_USER_ID_HASH_PATTERN = /^[a-f0-9]{64}$/;
const WECOM_CORP_GROUP_PATTERN = /^wecom:[a-f0-9]{12}$/;
const WECOM_IDENTITY_LINK_SECRET_PATTERN = /^[A-Za-z0-9_-]{43}$/;
const WECOM_IDENTITY_LINK_LIFETIME_MS = 10 * 60 * 1_000;
const WECOM_IDENTITY_LOGIN_LIFETIME_MS = 30 * 60 * 1_000;

function recordValue(value: unknown): Record<string, unknown> | undefined {
  return value && typeof value === "object" && !Array.isArray(value)
    ? value as Record<string, unknown>
    : undefined;
}

export function hashWeComUserId(userId: string) {
  return createHash("sha256").update(userId, "utf8").digest("hex");
}

export function hashWeComCorpId(corpId: string) {
  return createHash("sha256").update(corpId, "utf8").digest("hex");
}

function hashWeComLinkSecret(value: string) {
  return createHash("sha256").update(value, "utf8").digest("hex");
}

export function deriveTrustedWeComRelayIdentity(
  identity: { corpId: string; userId: string; relayIssuer: string },
  configuredCorpId: string,
) {
  const normalizedCorpId = identity.corpId.trim();
  const userId = identity.userId.trim();
  const expectedCorpId = configuredCorpId.trim();
  const corpIdHash = hashWeComCorpId(normalizedCorpId);
  let relayIssuer = "";
  try {
    const parsed = new URL(identity.relayIssuer);
    if (
      !["http:", "https:"].includes(parsed.protocol)
      || parsed.username
      || parsed.password
      || parsed.pathname !== "/wecom"
      || parsed.search
      || parsed.hash
    ) {
      throw new Error("invalid issuer");
    }
    relayIssuer = parsed.toString().replace(/\/$/, "");
  } catch {
    throw new IntegrationStoreError("企业微信中继身份签发方无效", 403, "invalid_wecom_identity");
  }
  if (!normalizedCorpId || normalizedCorpId !== expectedCorpId || !userId) {
    throw new IntegrationStoreError(
      "中继返回的企业微信身份不属于当前配置企业",
      403,
      "invalid_wecom_identity",
    );
  }
  if (userId.length > 256) {
    throw new IntegrationStoreError("企微 UserID 长度无效", 403, "invalid_wecom_identity");
  }
  return {
    wecomIssuer: relayIssuer,
    wecomSubject: `wecom_${createHash("sha256")
      .update(`${normalizedCorpId}\0${userId}`, "utf8")
      .digest("base64url")}`,
    corpIdHash,
    userIdHash: hashWeComUserId(userId),
  };
}

function validateWeComIdentityLoginSecrets(requestToken: string, browserNonce: string) {
  if (
    !WECOM_IDENTITY_LINK_SECRET_PATTERN.test(requestToken)
    || !WECOM_IDENTITY_LINK_SECRET_PATTERN.test(browserNonce)
  ) {
    throw new IntegrationStoreError("企微自动登录请求无效", 400, "invalid_wecom_link_request");
  }
}

async function configuredWeComOrganization(client: PoolClient, organizationId: string) {
  const configuration = await client.query<{
    id: string;
    organization_name: string;
    corp_id: string;
  }>(`
    SELECT id, organization_name, corp_id
    FROM wecom_authentication_organizations
    WHERE id = $1 AND active
      AND corp_id <> ''
      AND app_secret_ciphertext IS NOT NULL
      AND relay_callback_url IS NOT NULL
  `, [organizationId]);
  const organization = configuration.rows[0];
  if (!organization) {
    throw new IntegrationStoreError(
      "企业微信认证组织尚未配置或已停用",
      503,
      "wecom_authentication_unavailable",
    );
  }
  return organization;
}

function linkedPlatformIdentity(row: WeComIdentityLinkRow): WeComLinkedPlatformIdentity {
  if (!row.principal_email || !row.principal_name) {
    throw new IntegrationStoreError("企业微信绑定缺少平台身份", 500, "invalid_wecom_identity");
  }
  return {
    linkId: row.id,
    organizationId: row.organization_id,
    principalIssuer: row.principal_issuer,
    principalSubject: row.principal_subject,
    email: row.principal_email,
    name: row.principal_name,
  };
}

export async function createWeComIdentityLoginRequest(organizationId: string) {
  await ensureSchema();
  const requestToken = randomBytes(32).toString("base64url");
  const browserNonce = randomBytes(32).toString("base64url");
  const expiresAt = new Date(Date.now() + WECOM_IDENTITY_LOGIN_LIFETIME_MS);
  const client = await getPool().connect();
  try {
    await client.query("BEGIN");
    await configuredWeComOrganization(client, organizationId);
    await client.query(`
      DELETE FROM wecom_identity_login_requests
      WHERE expires_at < NOW() - INTERVAL '1 day' OR consumed_at IS NOT NULL
    `);
    await client.query(`
      INSERT INTO wecom_identity_login_requests (
        request_hash, browser_nonce_hash, organization_id, expires_at
      ) VALUES ($1, $2, $3, $4)
    `, [
      hashWeComLinkSecret(requestToken),
      hashWeComLinkSecret(browserNonce),
      organizationId,
      expiresAt,
    ]);
    await client.query("COMMIT");
    return { requestToken, browserNonce, expiresAt: expiresAt.toISOString() };
  } catch (error) {
    await client.query("ROLLBACK");
    throw error;
  } finally {
    client.release();
  }
}

export async function resolveWeComIdentityLoginRequest(
  requestToken: string,
  browserNonce: string,
  relayIdentity: { corpId: string; userId: string; relayIssuer: string },
): Promise<
  | { status: "linked"; identity: WeComLinkedPlatformIdentity }
  | { status: "login_required" }
> {
  validateWeComIdentityLoginSecrets(requestToken, browserNonce);
  await ensureSchema();
  const client = await getPool().connect();
  try {
    await client.query("BEGIN");
    const requestResult = await client.query<WeComIdentityLoginRequestRow>(`
      SELECT request_hash, browser_nonce_hash, organization_id, wecom_issuer, wecom_subject,
             wecom_corp_id_hash, wecom_user_id_hash, created_at, expires_at,
             verified_at, consumed_at
      FROM wecom_identity_login_requests
      WHERE request_hash = $1 AND browser_nonce_hash = $2 AND consumed_at IS NULL
      FOR UPDATE
    `, [hashWeComLinkSecret(requestToken), hashWeComLinkSecret(browserNonce)]);
    const loginRequest = requestResult.rows[0];
    if (!loginRequest || new Date(loginRequest.expires_at).getTime() <= Date.now()) {
      throw new IntegrationStoreError(
        "企微自动登录请求已失效，请重新打开应用",
        410,
        "expired_wecom_link_request",
      );
    }

    if (!loginRequest.organization_id) {
      throw new IntegrationStoreError("企微自动登录请求缺少组织", 400, "invalid_wecom_link_request");
    }
    const organization = await configuredWeComOrganization(client, loginRequest.organization_id);
    const trusted = deriveTrustedWeComRelayIdentity(relayIdentity, organization.corp_id);
    const existing = await client.query<WeComIdentityLinkRow>(`
      SELECT id, organization_id, principal_issuer, principal_subject, principal_email, principal_name,
             wecom_issuer, wecom_subject, wecom_corp_id_hash, wecom_user_id_hash,
             linked_at, updated_at
      FROM wecom_identity_links
      WHERE (wecom_issuer = $1 AND wecom_subject = $2)
         OR (wecom_corp_id_hash = $3 AND wecom_user_id_hash = $4)
      FOR UPDATE
    `, [trusted.wecomIssuer, trusted.wecomSubject, trusted.corpIdHash, trusted.userIdHash]);
    if (existing.rows.length > 1) {
      throw new IntegrationStoreError(
        "企业微信身份存在冲突绑定",
        409,
        "wecom_identity_conflict",
      );
    }

    await client.query(`
      UPDATE wecom_identity_login_requests
      SET wecom_issuer = $2,
          wecom_subject = $3,
          wecom_corp_id_hash = $4,
          wecom_user_id_hash = $5,
          verified_at = NOW(),
          consumed_at = CASE WHEN $6::BOOLEAN THEN NOW() ELSE NULL END
      WHERE request_hash = $1
    `, [
      loginRequest.request_hash,
      trusted.wecomIssuer,
      trusted.wecomSubject,
      trusted.corpIdHash,
      trusted.userIdHash,
      existing.rows.length === 1,
    ]);
    await client.query("COMMIT");
    return existing.rows[0]
      ? { status: "linked", identity: linkedPlatformIdentity(existing.rows[0]) }
      : { status: "login_required" };
  } catch (error) {
    await client.query("ROLLBACK");
    throw error;
  } finally {
    client.release();
  }
}

export async function completeVerifiedWeComIdentityLinkRequest(
  requestToken: string,
  browserNonce: string,
  platformIdentity: ConsoleIdentity,
) {
  validateWeComIdentityLoginSecrets(requestToken, browserNonce);
  await ensureSchema();
  const client = await getPool().connect();
  try {
    await client.query("BEGIN");
    const requestResult = await client.query<WeComIdentityLoginRequestRow>(`
      SELECT request_hash, browser_nonce_hash, organization_id, wecom_issuer, wecom_subject,
             wecom_corp_id_hash, wecom_user_id_hash, created_at, expires_at,
             verified_at, consumed_at
      FROM wecom_identity_login_requests
      WHERE request_hash = $1 AND browser_nonce_hash = $2 AND consumed_at IS NULL
      FOR UPDATE
    `, [hashWeComLinkSecret(requestToken), hashWeComLinkSecret(browserNonce)]);
    const loginRequest = requestResult.rows[0];
    if (
      !loginRequest
      || !loginRequest.verified_at
      || !loginRequest.organization_id
      || !loginRequest.wecom_issuer
      || !loginRequest.wecom_subject
      || !loginRequest.wecom_corp_id_hash
      || !loginRequest.wecom_user_id_hash
      || new Date(loginRequest.expires_at).getTime() <= Date.now()
    ) {
      throw new IntegrationStoreError(
        "企微身份登录交接已失效，请重新打开应用",
        410,
        "expired_wecom_link_request",
      );
    }

    const existing = await client.query<WeComIdentityLinkRow>(`
      SELECT id, organization_id, principal_issuer, principal_subject, principal_email, principal_name,
             wecom_issuer, wecom_subject, wecom_corp_id_hash, wecom_user_id_hash,
             linked_at, updated_at
      FROM wecom_identity_links
      WHERE (wecom_issuer = $1 AND wecom_subject = $2)
         OR (wecom_corp_id_hash = $3 AND wecom_user_id_hash = $4)
      FOR UPDATE
    `, [
      loginRequest.wecom_issuer,
      loginRequest.wecom_subject,
      loginRequest.wecom_corp_id_hash,
      loginRequest.wecom_user_id_hash,
    ]);
    if (existing.rows.some((row) => (
      row.principal_issuer !== platformIdentity.principalIssuer
      || row.principal_subject !== platformIdentity.principalSubject
    ))) {
      throw new IntegrationStoreError(
        "该企微身份已绑定到另一个平台账号",
        409,
        "wecom_identity_conflict",
      );
    }

    const linked = await client.query<Pick<WeComIdentityLinkRow, "id">>(`
      INSERT INTO wecom_identity_links (
        organization_id, principal_issuer, principal_subject, principal_email, principal_name,
        wecom_issuer, wecom_subject, wecom_corp_id_hash, wecom_user_id_hash
      ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)
      ON CONFLICT (principal_issuer, principal_subject, organization_id) DO UPDATE SET
        principal_email = EXCLUDED.principal_email,
        principal_name = EXCLUDED.principal_name,
        wecom_issuer = EXCLUDED.wecom_issuer,
        wecom_subject = EXCLUDED.wecom_subject,
        wecom_corp_id_hash = EXCLUDED.wecom_corp_id_hash,
        wecom_user_id_hash = EXCLUDED.wecom_user_id_hash,
        linked_at = NOW(),
        updated_at = NOW()
      RETURNING id
    `, [
      loginRequest.organization_id,
      platformIdentity.principalIssuer,
      platformIdentity.principalSubject,
      platformIdentity.email,
      platformIdentity.name,
      loginRequest.wecom_issuer,
      loginRequest.wecom_subject,
      loginRequest.wecom_corp_id_hash,
      loginRequest.wecom_user_id_hash,
    ]);
    await client.query(`
      UPDATE wecom_identity_login_requests
      SET consumed_at = NOW()
      WHERE request_hash = $1 AND consumed_at IS NULL
    `, [loginRequest.request_hash]);
    await client.query("COMMIT");
    return { linked: true as const, linkId: linked.rows[0].id };
  } catch (error) {
    await client.query("ROLLBACK");
    if (error && typeof error === "object" && "code" in error && error.code === "23505") {
      throw new IntegrationStoreError(
        "该企微身份已绑定到另一个平台账号",
        409,
        "wecom_identity_conflict",
      );
    }
    throw error;
  } finally {
    client.release();
  }
}

export async function getWeComLinkedPlatformIdentity(
  principalIssuer: string,
  principalSubject: string,
  linkId?: string,
): Promise<WeComLinkedPlatformIdentity | undefined> {
  await ensureSchema();
  const result = await getPool().query<WeComIdentityLinkRow>(`
    SELECT id, organization_id, principal_issuer, principal_subject, principal_email, principal_name,
           wecom_issuer, wecom_subject, wecom_corp_id_hash, wecom_user_id_hash,
           linked_at, updated_at
    FROM wecom_identity_links
    WHERE principal_issuer = $1 AND principal_subject = $2
      AND ($3::UUID IS NULL OR id = $3)
    ORDER BY linked_at DESC, id
    LIMIT 1
  `, [principalIssuer, principalSubject, linkId || null]);
  return result.rows[0] ? linkedPlatformIdentity(result.rows[0]) : undefined;
}

export async function createWeComIdentityLinkRequest(identity: ConsoleIdentity) {
  await ensureSchema();
  const requestToken = randomBytes(32).toString("base64url");
  const browserNonce = randomBytes(32).toString("base64url");
  const expiresAt = new Date(Date.now() + WECOM_IDENTITY_LINK_LIFETIME_MS);
  const client = await getPool().connect();
  try {
    await client.query("BEGIN");
    await client.query(`
      DELETE FROM wecom_identity_link_requests
      WHERE expires_at < NOW() - INTERVAL '1 day' OR consumed_at IS NOT NULL
    `);
    await client.query(`
      DELETE FROM wecom_identity_link_requests
      WHERE principal_issuer = $1 AND principal_subject = $2 AND consumed_at IS NULL
    `, [identity.principalIssuer, identity.principalSubject]);
    await client.query(`
      INSERT INTO wecom_identity_link_requests (
        request_hash, browser_nonce_hash, principal_issuer, principal_subject,
        principal_email, principal_name, expires_at
      ) VALUES ($1, $2, $3, $4, $5, $6, $7)
    `, [
      hashWeComLinkSecret(requestToken),
      hashWeComLinkSecret(browserNonce),
      identity.principalIssuer,
      identity.principalSubject,
      identity.email,
      identity.name,
      expiresAt,
    ]);
    await client.query("COMMIT");
    return { requestToken, browserNonce, expiresAt: expiresAt.toISOString() };
  } catch (error) {
    await client.query("ROLLBACK");
    throw error;
  } finally {
    client.release();
  }
}

export async function completeWeComIdentityLinkRequest(
  requestToken: string,
  browserNonce: string,
  platformIdentity: ConsoleIdentity,
  relayIdentity: { corpId: string; userId: string; relayIssuer: string },
) {
  if (
    !WECOM_IDENTITY_LINK_SECRET_PATTERN.test(requestToken)
    || !WECOM_IDENTITY_LINK_SECRET_PATTERN.test(browserNonce)
  ) {
    throw new IntegrationStoreError("企微身份绑定请求无效", 400, "invalid_wecom_link_request");
  }
  await ensureSchema();
  const client = await getPool().connect();
  try {
    await client.query("BEGIN");
    const requestResult = await client.query<WeComIdentityLinkRequestRow>(`
      SELECT request_hash, browser_nonce_hash, principal_issuer, principal_subject,
             principal_email, principal_name, created_at, expires_at, consumed_at
      FROM wecom_identity_link_requests
      WHERE request_hash = $1 AND browser_nonce_hash = $2 AND consumed_at IS NULL
      FOR UPDATE
    `, [hashWeComLinkSecret(requestToken), hashWeComLinkSecret(browserNonce)]);
    const linkRequest = requestResult.rows[0];
    if (!linkRequest || new Date(linkRequest.expires_at).getTime() <= Date.now()) {
      throw new IntegrationStoreError(
        "企微身份绑定请求已失效，请重新发起",
        410,
        "expired_wecom_link_request",
      );
    }
    if (
      linkRequest.principal_issuer !== platformIdentity.principalIssuer
      || linkRequest.principal_subject !== platformIdentity.principalSubject
    ) {
      throw new IntegrationStoreError(
        "企微身份绑定请求不属于当前平台账号",
        403,
        "invalid_wecom_link_request",
      );
    }
    const configuration = await client.query<{ id: string; corp_id: string }>(`
      SELECT id, corp_id
      FROM wecom_authentication_organizations
      WHERE corp_id = $1 AND active AND app_secret_ciphertext IS NOT NULL
    `, [relayIdentity.corpId.trim()]);
    const organization = configuration.rows[0];
    if (!organization) {
      throw new IntegrationStoreError("企业微信认证尚未配置", 503, "wecom_authentication_unavailable");
    }
    const trusted = deriveTrustedWeComRelayIdentity(relayIdentity, organization.corp_id);
    const existing = await client.query<WeComIdentityLinkRow>(`
      SELECT id, organization_id, principal_issuer, principal_subject, wecom_issuer, wecom_subject,
             wecom_corp_id_hash, wecom_user_id_hash, linked_at, updated_at
      FROM wecom_identity_links
      WHERE (wecom_issuer = $1 AND wecom_subject = $2)
         OR (wecom_corp_id_hash = $3 AND wecom_user_id_hash = $4)
      FOR UPDATE
    `, [trusted.wecomIssuer, trusted.wecomSubject, trusted.corpIdHash, trusted.userIdHash]);
    if (existing.rows.some((row) => (
      row.principal_issuer !== linkRequest.principal_issuer
      || row.principal_subject !== linkRequest.principal_subject
    ))) {
      throw new IntegrationStoreError(
        "该企微身份已绑定到另一个平台账号",
        409,
        "wecom_identity_conflict",
      );
    }
    const linked = await client.query<WeComIdentityLinkRow>(`
      INSERT INTO wecom_identity_links (
        organization_id, principal_issuer, principal_subject, principal_email, principal_name,
        wecom_issuer, wecom_subject, wecom_corp_id_hash, wecom_user_id_hash
      ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)
      ON CONFLICT (principal_issuer, principal_subject, organization_id) DO UPDATE SET
        principal_email = EXCLUDED.principal_email,
        principal_name = EXCLUDED.principal_name,
        wecom_issuer = EXCLUDED.wecom_issuer,
        wecom_subject = EXCLUDED.wecom_subject,
        wecom_corp_id_hash = EXCLUDED.wecom_corp_id_hash,
        wecom_user_id_hash = EXCLUDED.wecom_user_id_hash,
        linked_at = NOW(),
        updated_at = NOW()
      RETURNING id, organization_id, principal_issuer, principal_subject, wecom_issuer, wecom_subject,
                wecom_corp_id_hash, wecom_user_id_hash, linked_at, updated_at
    `, [
      organization.id,
      linkRequest.principal_issuer,
      linkRequest.principal_subject,
      linkRequest.principal_email,
      linkRequest.principal_name,
      trusted.wecomIssuer,
      trusted.wecomSubject,
      trusted.corpIdHash,
      trusted.userIdHash,
    ]);
    await client.query(`
      UPDATE wecom_identity_link_requests SET consumed_at = NOW() WHERE request_hash = $1
    `, [linkRequest.request_hash]);
    await client.query("COMMIT");
    return {
      linked: true as const,
      linkedAt: new Date(linked.rows[0].linked_at).toISOString(),
    };
  } catch (error) {
    await client.query("ROLLBACK");
    if (
      error
      && typeof error === "object"
      && "code" in error
      && error.code === "23505"
    ) {
      throw new IntegrationStoreError(
        "该企微身份已绑定到另一个平台账号",
        409,
        "wecom_identity_conflict",
      );
    }
    throw error;
  } finally {
    client.release();
  }
}

export async function getWeComIdentityLinkSnapshot(
  identity: Pick<ConsoleIdentity, "principalIssuer" | "principalSubject">,
): Promise<EmployeeIntegrationsSnapshot["wecomIdentity"]> {
  await ensureSchema();
  const result = await getPool().query<Pick<
    WeComIdentityLinkRow,
    "id" | "organization_id" | "organization_name" | "linked_at"
  >>(`
    SELECT identity_link.id, identity_link.organization_id,
           organization.organization_name, identity_link.linked_at
    FROM wecom_identity_links AS identity_link
    JOIN wecom_authentication_organizations AS organization
      ON organization.id = identity_link.organization_id
    WHERE identity_link.principal_issuer = $1 AND identity_link.principal_subject = $2
    ORDER BY organization.organization_name, identity_link.linked_at, identity_link.id
  `, [identity.principalIssuer, identity.principalSubject]);
  const identities = result.rows.map((row) => ({
    id: row.id,
    organizationId: row.organization_id,
    organizationName: row.organization_name || "企业微信组织",
    linkedAt: new Date(row.linked_at).toISOString(),
  }));
  return { linked: identities.length > 0, identities };
}

export async function disconnectWeComIdentityLink(
  identity: Pick<ConsoleIdentity, "principalIssuer" | "principalSubject">,
  linkId: string,
) {
  await ensureSchema();
  const safeLinkId = requiredUuid(linkId);
  const result = await getPool().query(`
    DELETE FROM wecom_identity_links
    WHERE principal_issuer = $1 AND principal_subject = $2 AND id = $3
  `, [identity.principalIssuer, identity.principalSubject, safeLinkId]);
  if (!result.rowCount) throw new IntegrationStoreError("当前账号尚未绑定企微身份", 404);
  return { disconnected: true as const };
}

async function getLinkedWeComIdentityClaims(issuer: string, subject: string) {
  const result = await getPool().query<Pick<
    WeComIdentityLinkRow,
    "organization_id" | "wecom_corp_id_hash" | "wecom_user_id_hash"
  >>(`
    SELECT organization_id, wecom_corp_id_hash, wecom_user_id_hash
    FROM wecom_identity_links
    WHERE principal_issuer = $1 AND principal_subject = $2
  `, [issuer, subject]);
  return result.rows.map((row) => ({
    organizationId: row.organization_id,
    corpGroup: `wecom:${row.wecom_corp_id_hash.slice(0, 12)}`,
    userIdHash: row.wecom_user_id_hash,
  }));
}

export function parseWeComVisibleUsers(value: unknown) {
  const payload = recordValue(value);
  if (!payload || payload.errcode !== 0 || !Array.isArray(payload.userlist)) {
    throw new IntegrationStoreError("企微机器人可见范围查询失败", 502);
  }
  const users: Array<{ userIdHash: string; name?: string }> = [];
  for (const item of payload.userlist) {
    const user = recordValue(item);
    if (typeof user?.userid === "string" && user.userid) {
      const name = typeof user.name === "string" ? user.name.trim() : "";
      users.push({
        userIdHash: hashWeComUserId(user.userid),
        ...(name ? { name } : {}),
      });
    }
  }
  return users;
}

export function parseWeComVisibleUserIdHashes(value: unknown) {
  return new Set(parseWeComVisibleUsers(value).map((user) => user.userIdHash));
}

async function readWeComVisibleUserIdHashes(connectionName: string) {
  const cache = globalThis.aiBaseWeComVisibilityCache ||= new Map();
  const cached = cache.get(connectionName);
  if (cached && cached.expiresAt > Date.now()) return cached.userIdHashes;
  cache.delete(connectionName);
  try {
    const userIdHashes = parseWeComVisibleUserIdHashes(
      await runConnectorAction("wecom_bot.get_userlist", connectionName),
    );
    cache.set(connectionName, {
      expiresAt: Date.now() + WECOM_VISIBILITY_CACHE_TTL_MS,
      userIdHashes,
    });
    return userIdHashes;
  } catch (error) {
    cache.delete(connectionName);
    throw error;
  }
}

export function resetWeComVisibilityCache() {
  globalThis.aiBaseWeComVisibilityCache = undefined;
}

async function resolveWeComVisibilityResources(input: {
  service?: string;
  identities: Array<{ organizationId: string; userIdHash: string }>;
}) {
  if (input.service && input.service !== "wecom_bot") return [];
  if (!input.identities.length) return [];
  if (input.identities.some((identity) => !WECOM_USER_ID_HASH_PATTERN.test(identity.userIdHash))) {
    throw new IntegrationStoreError("企微用户身份摘要格式无效", 400, "invalid_wecom_identity");
  }
  const userHashByOrganization = new Map(
    input.identities.map((identity) => [identity.organizationId, identity.userIdHash]),
  );

  const resources = await getPool().query<WeComVisibilityResourceRow>(`
    SELECT resource.id AS resource_id, resource.service, resource.connection_name,
           resource.display_name, resource.action_ids, resource.wecom_organization_id
    FROM shared_connector_resources AS resource
    JOIN wecom_authentication_organizations AS organization
      ON organization.id = resource.wecom_organization_id
    WHERE resource.enabled AND organization.active
      AND organization.app_secret_ciphertext IS NOT NULL
      AND organization.relay_callback_url IS NOT NULL
      AND resource.service = 'wecom_bot'
      AND resource.authorization_mode = 'wecom_visibility'
      AND resource.wecom_organization_id = ANY($2::UUID[])
      AND ($1::TEXT IS NULL OR resource.service = $1)
      AND NOT EXISTS (
        SELECT 1 FROM employee_connector_bindings AS personal_binding
        WHERE personal_binding.service = resource.service
          AND personal_binding.connection_name = resource.connection_name
          AND personal_binding.status <> 'revoked'
      )
    ORDER BY resource.connection_name
  `, [input.service || null, Array.from(userHashByOrganization.keys())]);

  const visible = await Promise.all(resources.rows.map(async (resource) => {
    try {
      const hashes = await readWeComVisibleUserIdHashes(resource.connection_name);
      const userIdHash = userHashByOrganization.get(resource.wecom_organization_id);
      return userIdHash && hashes.has(userIdHash) ? resource : undefined;
    } catch {
      return undefined;
    }
  }));
  return visible.filter((resource): resource is WeComVisibilityResourceRow => Boolean(resource));
}

export async function resolveEmployeeConnectorBindings(input: {
  issuer: string;
  subject: string;
  email?: string;
  groups?: string[];
  wecomUserIdHash?: string;
  clientId?: string;
  service?: string;
  requestedConnectionName?: string;
  actionId?: string;
}) {
  await ensureSchema();
  const issuer = requiredValue(input.issuer, "Issuer", 2_048);
  const subject = requiredValue(input.subject, "Subject", 512);
  const email = input.email?.trim().toLowerCase()
    ? requiredValue(input.email.trim().toLowerCase(), "Email", 320)
    : undefined;
  const service = input.service ? requiredValue(input.service, "Service", 128) : undefined;
  const requestedConnectionValue = input.requestedConnectionName
    ? requiredValue(input.requestedConnectionName, "Connection name", 128)
    : undefined;
  const requestedConnectionName = requestedConnectionValue?.toLowerCase() === "default"
    ? undefined
    : requestedConnectionValue;
  const actionId = input.actionId ? requiredValue(input.actionId, "Action ID", 384) : undefined;
  const groups = Array.from(new Set(
    (Array.isArray(input.groups) ? input.groups : [])
      .filter((group): group is string => typeof group === "string" && Boolean(group.trim()))
      .map((group) => group.trim().toLowerCase())
      .slice(0, 256),
  ));
  let linkedWeComIdentities = await getLinkedWeComIdentityClaims(issuer, subject);
  if (input.wecomUserIdHash) {
    if (!WECOM_USER_ID_HASH_PATTERN.test(input.wecomUserIdHash)) {
      throw new IntegrationStoreError("企微用户身份摘要格式无效", 400, "invalid_wecom_identity");
    }
    const corpGroups = groups.filter((group) => WECOM_CORP_GROUP_PATTERN.test(group));
    if (corpGroups.length !== 1) linkedWeComIdentities = [];
    else {
      const organizations = await getPool().query<{ id: string; corp_id: string }>(`
        SELECT id, corp_id FROM wecom_authentication_organizations WHERE active
      `);
      const organization = organizations.rows.find((candidate) => (
        `wecom:${hashWeComCorpId(candidate.corp_id).slice(0, 12)}` === corpGroups[0]
      ));
      linkedWeComIdentities = organization ? [{
        organizationId: organization.id,
        corpGroup: corpGroups[0],
        userIdHash: input.wecomUserIdHash,
      }] : [];
    }
  }
  let result = await getPool().query<EmployeeConnectorBindingRow>(`
    SELECT binding.id, binding.application_id, binding.platform, binding.service,
           binding.connection_name, binding.status, binding.display_name,
           binding.account_id, binding.error_message, binding.connected_at,
           binding.updated_at,
           CASE WHEN binding.application_id IS NULL THEN binding.action_ids ELSE application.action_ids END AS action_ids
    FROM employee_connector_bindings AS binding
    LEFT JOIN integration_applications AS application ON application.id = binding.application_id
    WHERE binding.principal_issuer = $1 AND binding.principal_subject = $2
      AND binding.status = 'connected'
      AND ($3::TEXT IS NULL OR binding.service = $3)
    ORDER BY binding.service, binding.connection_name
  `, [issuer, subject, service || null]);

  // Compatibility for rows written before Console and the MCP Broker shared
  // the same opaque-subject derivation. The email comes from a broker-verified
  // token over the authenticated internal resolver channel; ambiguity fails closed.
  if (!result.rowCount && email) {
    result = await getPool().query<EmployeeConnectorBindingRow>(`
      SELECT binding.id, binding.application_id, binding.platform, binding.service,
             binding.connection_name, binding.status, binding.display_name,
             binding.account_id, binding.error_message, binding.connected_at,
             binding.updated_at,
             CASE WHEN binding.application_id IS NULL THEN binding.action_ids ELSE application.action_ids END AS action_ids
      FROM employee_connector_bindings AS binding
      LEFT JOIN integration_applications AS application ON application.id = binding.application_id
      WHERE binding.principal_issuer = $1 AND LOWER(binding.principal_email) = $2
        AND binding.status = 'connected'
        AND ($3::TEXT IS NULL OR binding.service = $3)
      ORDER BY binding.service, binding.connection_name
    `, [issuer, email, service || null]);
    const services = new Set<string>();
    for (const row of result.rows) {
      if (services.has(row.service) && row.platform !== "wecom_bot") {
        throw new IntegrationStoreError("员工账号存在冲突的 Connector 绑定", 409);
      }
      services.add(row.service);
    }
  }

  const [snapshot, sharedRows, wecomVisibilityRows] = await Promise.all([
    listConnectorConnections(),
    getPool().query<SharedConnectorGrantResolutionRow>(`
      SELECT resource.id AS resource_id, resource.service, resource.connection_name,
             resource.display_name, grant_row.action_ids, grant_row.id AS grant_id
      FROM shared_connector_resources AS resource
      JOIN shared_connector_grants AS grant_row ON grant_row.resource_id = resource.id
      WHERE resource.enabled AND resource.authorization_mode = 'manual' AND grant_row.enabled
        AND NOT EXISTS (
          SELECT 1 FROM employee_connector_bindings AS personal_binding
          WHERE personal_binding.service = resource.service
            AND personal_binding.connection_name = resource.connection_name
            AND personal_binding.status <> 'revoked'
        )
        AND (grant_row.starts_at IS NULL OR grant_row.starts_at <= NOW())
        AND (grant_row.expires_at IS NULL OR grant_row.expires_at > NOW())
        AND grant_row.principal_issuer = $1
        AND ($4::TEXT IS NULL OR resource.service = $4)
        AND (
          (
            grant_row.principal_type = 'user'
            AND (
              grant_row.principal_subject = $2
              OR (
                grant_row.principal_subject IS NULL
                AND $3::TEXT IS NOT NULL
                AND LOWER(grant_row.principal_email) = $3
              )
            )
          )
          OR (
            grant_row.principal_type = 'group'
            AND LOWER(grant_row.group_name) = ANY($5::TEXT[])
          )
        )
      ORDER BY resource.service, resource.connection_name, grant_row.created_at
    `, [issuer, subject, email || null, service || null, groups]),
    resolveWeComVisibilityResources({
      service,
      identities: linkedWeComIdentities,
    }),
  ]);
  const valid = new Map(
    snapshot.connections
      .filter((connection) => connection.configured)
      .map((connection) => [`${connection.service}\0${connection.connectionName}`, connection]),
  );
  const boundConnections = result.rows.flatMap((row) => {
    const current = valid.get(`${row.service}\0${row.connection_name}`);
    const allowedActionIds = storedActionIds(row.action_ids);
    return current ? [{
      service: row.service,
      connectionName: row.connection_name,
      displayName: row.display_name || current.profile.displayName,
      public: false,
      accessMode: "account_bound",
      actionRestricted: true,
      allowedActionIds,
    }] : [];
  });
  const sharedByConnection = new Map<string, {
    id: string;
    service: string;
    connectionName: string;
    displayName: string;
    public: false;
    accessMode: "controlled_shared";
    actionRestricted: true;
    allowedActionIds: Set<string>;
    policyIds: string[];
  }>();
  for (const row of sharedRows.rows) {
    const currentConnection = valid.get(`${row.service}\0${row.connection_name}`);
    if (!currentConnection) continue;
    const key = `${row.service}\0${row.connection_name}`;
    const current = sharedByConnection.get(key) || {
      id: row.resource_id,
      service: row.service,
      connectionName: row.connection_name,
      displayName: row.display_name || currentConnection.profile.displayName,
      public: false as const,
      accessMode: "controlled_shared" as const,
      actionRestricted: true as const,
      allowedActionIds: new Set<string>(),
      policyIds: [],
    };
    for (const candidate of Array.isArray(row.action_ids) ? row.action_ids : []) {
      if (typeof candidate === "string" && candidate.trim()) current.allowedActionIds.add(candidate.trim());
    }
    current.policyIds.push(row.grant_id);
    sharedByConnection.set(key, current);
  }
  const sharedConnections = Array.from(sharedByConnection.values()).map((connection) => ({
    ...connection,
    allowedActionIds: Array.from(connection.allowedActionIds).sort(),
  }));
  for (const row of wecomVisibilityRows) {
    const currentConnection = valid.get(`${row.service}\0${row.connection_name}`);
    if (!currentConnection) continue;
    sharedConnections.push({
      id: row.resource_id,
      service: row.service,
      connectionName: row.connection_name,
      displayName: row.display_name || currentConnection.profile.displayName,
      public: false,
      accessMode: "controlled_shared",
      actionRestricted: true,
      allowedActionIds: storedActionIds(row.action_ids)
        .filter((actionId) => !WECOM_BOT_SYSTEM_ONLY_ACTION_IDS.has(actionId))
        .sort(),
      policyIds: [`wecom-visibility:${row.resource_id}`],
    });
  }
  const boundServices = new Set([
    ...boundConnections.map((connection) => connection.service),
    ...sharedConnections.map((connection) => connection.service),
  ]);
  const publicConnections = snapshot.connections
    .filter((connection) => (
      connection.configured
      && connection.virtual
      && connection.authType === "no_auth"
      && !boundServices.has(connection.service)
    ))
    .map((connection) => ({
      service: connection.service,
      connectionName: "default",
      displayName: connection.profile.displayName,
      public: true,
      accessMode: "no_auth",
      actionRestricted: false,
    }));
  const connections = [...boundConnections, ...sharedConnections, ...publicConnections];

  if (service) {
    const serviceConnections = connections.filter((item) => item.service === service);
    if (!serviceConnections.length) {
      throw new IntegrationStoreError(
        "当前员工没有获授权的 Connector",
        404,
        "connector_not_authorized",
      );
    }
    let candidates = serviceConnections;
    if (requestedConnectionName) {
      candidates = candidates.filter((connection) => connection.connectionName === requestedConnectionName);
      if (!candidates.length) {
        throw new IntegrationStoreError(
          "当前员工无权使用请求的 Connector",
          403,
          "connector_not_authorized",
        );
      }
    }
    if (actionId) {
      candidates = candidates.filter((connection) => (
        !connection.actionRestricted
        || (
          "allowedActionIds" in connection
          && Array.isArray(connection.allowedActionIds)
          && connection.allowedActionIds.includes(actionId)
        )
      ));
      if (!candidates.length) {
        throw new IntegrationStoreError(
          "当前员工无权执行请求的 Action",
          403,
          "action_not_authorized",
        );
      }
    }
    if (candidates.length > 1) {
      throw new IntegrationStoreError(
        "当前服务存在多个可用 Connector，请明确指定连接名称",
        409,
        "connector_selection_required",
        { connectionNames: candidates.map((connection) => connection.connectionName) },
      );
    }
    return candidates[0];
  }
  void input.clientId;
  return { connections };
}

function requiredUuid(value: string) {
  if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(value)) {
    throw new IntegrationStoreError("无效的应用配置 ID", 400);
  }
  return value;
}

function isUniqueViolation(error: unknown) {
  return Boolean(error && typeof error === "object" && "code" in error && error.code === "23505");
}

function isForeignKeyViolation(error: unknown) {
  return Boolean(error && typeof error === "object" && "code" in error && error.code === "23503");
}
