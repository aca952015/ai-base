ALTER TABLE shared_connector_resources
  ADD COLUMN IF NOT EXISTS authorization_mode TEXT NOT NULL DEFAULT 'manual';

ALTER TABLE shared_connector_resources
  DROP CONSTRAINT IF EXISTS shared_connector_resources_authorization_mode_check;

ALTER TABLE shared_connector_resources
  ADD CONSTRAINT shared_connector_resources_authorization_mode_check
  CHECK (authorization_mode IN ('manual', 'wecom_visibility'));

ALTER TABLE shared_connector_resources
  ADD COLUMN IF NOT EXISTS action_ids JSONB NOT NULL DEFAULT '[]'::JSONB;
