package main

import (
	"context"
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"testing"
)

func TestRemoteAuthConfigurationProviderReadsLatestConsoleSettings(t *testing.T) {
	callbackURL := "https://relay-one.example.com/callbacks/wecom"
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if r.Header.Get("Authorization") != "Bearer internal-token" {
			t.Fatalf("authorization header = %q", r.Header.Get("Authorization"))
		}
		_ = json.NewEncoder(w).Encode(map[string]any{
			"configured": true,
			"runtime": map[string]string{
				"publicBaseUrl":     "https://ai.example.com/wecom-oidc/",
				"publicCallbackUrl": callbackURL,
				"emailDomain":       "Example.COM",
			},
			"application": map[string]string{
				"corpId":    "ww-corp",
				"appSecret": "app-secret",
			},
		})
	}))
	defer server.Close()

	provider := &remoteAuthConfigurationProvider{
		url: server.URL, token: "internal-token", client: server.Client(),
	}
	first, err := provider.Configuration(context.Background())
	if err != nil {
		t.Fatal(err)
	}
	if first.Runtime.PublicBaseURL != "https://ai.example.com/wecom-oidc" || first.Runtime.CookiePath != "/wecom-oidc" || !first.Runtime.SecureCookie {
		t.Fatalf("unexpected runtime configuration: %#v", first.Runtime)
	}
	if first.Runtime.EmailDomain != "example.com" || first.Application.CorpID != "ww-corp" {
		t.Fatalf("unexpected authentication configuration: %#v", first)
	}

	callbackURL = "https://relay-two.example.com/callbacks/wecom"
	second, err := provider.Configuration(context.Background())
	if err != nil {
		t.Fatal(err)
	}
	if second.Runtime.PublicCallbackURL != callbackURL {
		t.Fatalf("updated callback URL = %q", second.Runtime.PublicCallbackURL)
	}
}

func TestRemoteAuthConfigurationProviderKeepsRuntimeAvailableWithoutIntegration(t *testing.T) {
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, _ *http.Request) {
		w.WriteHeader(http.StatusNotFound)
		_, _ = w.Write([]byte(`{
			"configured":false,
			"runtime":{
				"publicBaseUrl":"http://127.0.0.1:8080/wecom-oidc",
				"publicCallbackUrl":"http://127.0.0.1:8080/wecom-oidc/callback",
				"emailDomain":"example.com"
			},
			"error":"企微尚未启用应用配置"
		}`))
	}))
	defer server.Close()

	provider := &remoteAuthConfigurationProvider{url: server.URL, token: "token", client: server.Client()}
	runtime, err := provider.Runtime(context.Background())
	if err != nil {
		t.Fatal(err)
	}
	if runtime.PublicCallbackURL != "http://127.0.0.1:8080/wecom-oidc/callback" || runtime.SecureCookie {
		t.Fatalf("unexpected runtime configuration: %#v", runtime)
	}
	if _, err := provider.Configuration(context.Background()); err == nil {
		t.Fatal("expected missing integration error")
	}
}

func TestValidateWeComRuntimeConfigRejectsUnsafeURLs(t *testing.T) {
	_, err := validateWeComRuntimeConfig(wecomRuntimeConfig{
		PublicBaseURL:     "https://user:pass@ai.example.com/wecom-oidc",
		PublicCallbackURL: "https://relay.example.com/callback?target=attacker",
		EmailDomain:       "example.com",
	})
	if err == nil {
		t.Fatal("expected runtime URL validation error")
	}
}
