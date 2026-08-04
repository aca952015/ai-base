package main

import "testing"

func setRequiredConfigEnvironment(t *testing.T) {
	t.Helper()
	t.Setenv("WECOM_AUTH_ISSUER", "http://wecom-auth-bridge:8082")
	t.Setenv("WECOM_AUTH_PUBLIC_BASE_URL", "http://127.0.0.1:8080/wecom-oidc")
	t.Setenv("WECOM_OIDC_CLIENT_ID", "ai-base-dex")
	t.Setenv("WECOM_OIDC_CLIENT_SECRET", "test-client-secret-with-enough-bytes")
	t.Setenv("WECOM_DEX_REDIRECT_URI", "http://dex.localtest.me:5556/dex/callback")
	t.Setenv("WECOM_INTEGRATION_CONFIG_URL", "http://ai-console:3000/api/internal/wecom-auth/config")
	t.Setenv("WECOM_AUTH_BRIDGE_CONFIG_TOKEN", "test-config-token-with-enough-bytes")
	t.Setenv("WECOM_EMAIL_DOMAIN", "example.com")
}

func TestLoadConfigUsesDedicatedPublicCallbackURL(t *testing.T) {
	setRequiredConfigEnvironment(t)
	t.Setenv("WECOM_AUTH_CALLBACK_URL", "https://auth-relay.example.com/callbacks/wecom")

	cfg, err := loadConfig()
	if err != nil {
		t.Fatal(err)
	}
	if cfg.publicCallbackURL != "https://auth-relay.example.com/callbacks/wecom" {
		t.Fatalf("public callback URL = %q", cfg.publicCallbackURL)
	}
	if cfg.publicBaseURL != "http://127.0.0.1:8080/wecom-oidc" {
		t.Fatalf("public base URL = %q", cfg.publicBaseURL)
	}
}

func TestLoadConfigDefaultsCallbackToPublicBaseURL(t *testing.T) {
	setRequiredConfigEnvironment(t)
	t.Setenv("WECOM_AUTH_CALLBACK_URL", "")

	cfg, err := loadConfig()
	if err != nil {
		t.Fatal(err)
	}
	if cfg.publicCallbackURL != "http://127.0.0.1:8080/wecom-oidc/callback" {
		t.Fatalf("public callback URL = %q", cfg.publicCallbackURL)
	}
}

func TestLoadConfigRejectsCallbackURLWithQuery(t *testing.T) {
	setRequiredConfigEnvironment(t)
	t.Setenv("WECOM_AUTH_CALLBACK_URL", "https://relay.example.com/wecom/callback?target=attacker")

	if _, err := loadConfig(); err == nil {
		t.Fatal("expected callback URL validation error")
	}
}
