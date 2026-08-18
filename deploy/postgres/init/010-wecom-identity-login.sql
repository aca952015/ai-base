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
