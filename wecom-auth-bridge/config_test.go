package main

import "testing"

func setRequiredConfigEnvironment(t *testing.T) {
	t.Helper()
	t.Setenv("WECOM_AUTH_ISSUER", "http://wecom-auth-bridge:8082")
	t.Setenv("WECOM_OIDC_CLIENT_ID", "ai-base-dex")
	t.Setenv("WECOM_OIDC_CLIENT_SECRET", "test-client-secret-with-enough-bytes")
	t.Setenv("WECOM_DEX_REDIRECT_URI", "http://dex.localtest.me:5556/dex/callback")
	t.Setenv("WECOM_INTEGRATION_CONFIG_URL", "http://ai-console:3000/api/internal/wecom-auth/config")
	t.Setenv("WECOM_AUTH_BRIDGE_CONFIG_TOKEN", "test-config-token-with-enough-bytes")
}

func TestLoadConfigOnlyRequiresBootstrapTrustSettings(t *testing.T) {
	setRequiredConfigEnvironment(t)

	cfg, err := loadConfig()
	if err != nil {
		t.Fatal(err)
	}
	if cfg.integrationConfigURL != "http://ai-console:3000/api/internal/wecom-auth/config" {
		t.Fatalf("configuration URL = %q", cfg.integrationConfigURL)
	}
}

func TestLoadConfigDoesNotReadAdminManagedRuntimeSettings(t *testing.T) {
	setRequiredConfigEnvironment(t)
	t.Setenv("WECOM_AUTH_PUBLIC_BASE_URL", "://invalid")
	t.Setenv("WECOM_AUTH_CALLBACK_URL", "https://attacker.example/callback")
	t.Setenv("WECOM_EMAIL_DOMAIN", "invalid")

	if _, err := loadConfig(); err != nil {
		t.Fatal(err)
	}
}
