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
