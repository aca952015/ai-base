CREATE TABLE IF NOT EXISTS shared_connector_resources (
  id UUID PRIMARY KEY,
  service TEXT NOT NULL,
  connection_name TEXT NOT NULL,
  display_name TEXT NOT NULL,
  security_domain TEXT NOT NULL DEFAULT 'general',
  enabled BOOLEAN NOT NULL DEFAULT TRUE,
  created_by TEXT NOT NULL,
  updated_by TEXT NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  UNIQUE (service, connection_name)
);

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
  WHERE principal_type = 'group';
