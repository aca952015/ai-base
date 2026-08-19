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
  '默认组织',
  corp_id,
  app_secret_ciphertext,
  relay_callback_url,
  TRUE,
  created_at,
  updated_at
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
  ),
  updated_at = GREATEST(
    wecom_authentication_organizations.updated_at,
    EXCLUDED.updated_at
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

UPDATE wecom_identity_login_requests AS request
SET organization_id = '00000000-0000-0000-0000-000000000001'::UUID
WHERE request.organization_id IS NULL
  AND EXISTS (
    SELECT 1 FROM wecom_authentication_organizations
    WHERE id = '00000000-0000-0000-0000-000000000001'::UUID
  );

UPDATE wecom_identity_links AS identity_link
SET organization_id = '00000000-0000-0000-0000-000000000001'::UUID
WHERE identity_link.organization_id IS NULL
  AND EXISTS (
    SELECT 1 FROM wecom_authentication_organizations
    WHERE id = '00000000-0000-0000-0000-000000000001'::UUID
  );

DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM wecom_identity_links WHERE organization_id IS NULL) THEN
    RAISE EXCEPTION 'Cannot migrate WeCom identities: at least one identity has no matching organization';
  END IF;
END $$;

ALTER TABLE wecom_identity_links
  ALTER COLUMN id SET NOT NULL,
  ALTER COLUMN organization_id SET NOT NULL;

DO $$
DECLARE primary_key_name TEXT;
BEGIN
  SELECT constraint_row.conname INTO primary_key_name
  FROM pg_constraint AS constraint_row
  WHERE constraint_row.conrelid = 'wecom_identity_links'::regclass
    AND constraint_row.contype = 'p';
  IF primary_key_name IS NOT NULL
     AND pg_get_constraintdef((SELECT oid FROM pg_constraint WHERE conname = primary_key_name
       AND conrelid = 'wecom_identity_links'::regclass)) <> 'PRIMARY KEY (id)' THEN
    EXECUTE format('ALTER TABLE wecom_identity_links DROP CONSTRAINT %I', primary_key_name);
  END IF;
END $$;

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conrelid = 'wecom_identity_links'::regclass
      AND contype = 'p'
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
    RAISE EXCEPTION 'Cannot migrate WeCom shared connectors: at least one resource has no matching organization';
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
