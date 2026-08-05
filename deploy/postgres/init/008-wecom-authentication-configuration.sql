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
