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
