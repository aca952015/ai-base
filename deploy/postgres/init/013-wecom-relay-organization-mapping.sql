UPDATE wecom_authentication_organizations AS organization
SET relay_callback_url = NULL, active = FALSE, updated_at = NOW()
WHERE organization.relay_callback_url IN (
  SELECT duplicate.relay_callback_url
  FROM wecom_authentication_organizations AS duplicate
  WHERE duplicate.relay_callback_url IS NOT NULL
  GROUP BY duplicate.relay_callback_url
  HAVING COUNT(*) > 1
);

CREATE UNIQUE INDEX IF NOT EXISTS wecom_authentication_organizations_relay_callback_url_idx
  ON wecom_authentication_organizations(relay_callback_url)
  WHERE relay_callback_url IS NOT NULL;
