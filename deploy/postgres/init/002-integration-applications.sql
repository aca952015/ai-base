CREATE TABLE IF NOT EXISTS integration_applications (
  id UUID PRIMARY KEY,
  platform TEXT NOT NULL CHECK (platform IN ('feishu', 'wecom', 'dingtalk')),
  app_name TEXT NOT NULL,
  app_id TEXT NOT NULL,
  note TEXT NOT NULL DEFAULT '',
  app_secret_ciphertext TEXT NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  UNIQUE (platform, app_id)
);
