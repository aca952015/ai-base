CREATE TABLE IF NOT EXISTS integration_applications (
  id UUID PRIMARY KEY,
  platform TEXT NOT NULL CHECK (platform IN ('feishu', 'wecom', 'dingtalk')),
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

CREATE TABLE IF NOT EXISTS employee_connector_bindings (
  id UUID PRIMARY KEY,
  application_id UUID NOT NULL REFERENCES integration_applications(id) ON DELETE RESTRICT,
  principal_issuer TEXT NOT NULL,
  principal_subject TEXT NOT NULL,
  principal_email TEXT NOT NULL,
  principal_name TEXT NOT NULL,
  platform TEXT NOT NULL CHECK (platform IN ('feishu', 'wecom', 'dingtalk')),
  service TEXT NOT NULL,
  connection_name TEXT NOT NULL,
  status TEXT NOT NULL CHECK (status IN ('pending', 'connected', 'error', 'revoked')),
  display_name TEXT,
  account_id TEXT,
  error_message TEXT,
  connected_at TIMESTAMPTZ,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  UNIQUE (principal_issuer, principal_subject, service),
  UNIQUE (service, connection_name)
);

CREATE INDEX IF NOT EXISTS employee_connector_bindings_principal_idx
  ON employee_connector_bindings(principal_issuer, principal_subject, status);
