package main

import (
	"context"
	"encoding/json"
	"io"
	"net/http"
	"net/http/httptest"
	"net/url"
	"strings"
	"testing"
	"time"
)

type fakeVerifier struct {
	identities map[string]identity
}

func (v fakeVerifier) verify(_ context.Context, token string) (identity, error) {
	caller, ok := v.identities[token]
	if !ok {
		return identity{}, errInvalidToken
	}
	return caller, nil
}

func testConfig(t *testing.T, upstream string) config {
	t.Helper()
	upstreamURL, err := url.Parse(upstream)
	if err != nil {
		t.Fatal(err)
	}
	return config{
		upstreamURL:     upstreamURL,
		resourceURL:     "https://mcp.example/mcp",
		metadataURL:     "https://mcp.example/.well-known/oauth-protected-resource/mcp",
		issuer:          "https://id.example",
		audience:        "ai-base-mcp",
		requiredScopes:  []string{"ai-base:mcp"},
		signingKey:      []byte("test-session-signing-key-at-least-32-bytes"),
		sessionLifetime: time.Hour,
		adminToken:      "test-mcp-admin-token",
	}
}

func TestMetadataAndUnauthorizedChallenge(t *testing.T) {
	cfg := testConfig(t, "http://127.0.0.1:1/mcp")
	gateway := newMCPGateway(cfg, fakeVerifier{})
	server := httptest.NewServer(gateway.routes())
	defer server.Close()

	response, err := http.Get(server.URL + "/.well-known/oauth-protected-resource/mcp")
	if err != nil {
		t.Fatal(err)
	}
	defer response.Body.Close()
	if response.StatusCode != http.StatusOK {
		t.Fatalf("expected metadata 200, got %d", response.StatusCode)
	}

	response, err = http.Post(server.URL+"/mcp", "application/json", strings.NewReader(`{}`))
	if err != nil {
		t.Fatal(err)
	}
	defer response.Body.Close()
	if response.StatusCode != http.StatusUnauthorized {
		t.Fatalf("expected 401, got %d", response.StatusCode)
	}
	if challenge := response.Header.Get("WWW-Authenticate"); !strings.Contains(challenge, cfg.metadataURL) {
		t.Fatalf("challenge does not advertise metadata: %s", challenge)
	}

	request, _ := http.NewRequest(http.MethodPost, server.URL+"/mcp?access_token=must-not-transit", strings.NewReader(`{}`))
	request.Header.Set("Authorization", "Bearer otherwise-valid")
	response, err = http.DefaultClient.Do(request)
	if err != nil {
		t.Fatal(err)
	}
	defer response.Body.Close()
	if response.StatusCode != http.StatusBadRequest {
		t.Fatalf("expected query token rejection, got %d", response.StatusCode)
	}
}

func TestProxyStripsTokenAndBindsSession(t *testing.T) {
	var upstreamAuthorization string
	var upstreamSession string
	upstream := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		upstreamAuthorization = r.Header.Get("Authorization")
		upstreamSession = r.Header.Get(sessionHeader)
		w.Header().Set("Content-Type", "application/json")
		if upstreamSession == "" {
			w.Header().Set(sessionHeader, "envoy-session")
		}
		_, _ = io.WriteString(w, `{"jsonrpc":"2.0","result":{}}`)
	}))
	defer upstream.Close()

	alice := identity{
		issuer:      "https://id.example",
		subject:     "alice",
		clientID:    "workbuddy",
		displayName: "Alice",
		email:       "alice@example.com",
	}
	bob := identity{issuer: "https://id.example", subject: "bob", clientID: "workbuddy"}
	cfg := testConfig(t, upstream.URL+"/mcp")
	gateway := newMCPGateway(cfg, fakeVerifier{identities: map[string]identity{
		"alice-token": alice,
		"bob-token":   bob,
	}})
	server := httptest.NewServer(gateway.routes())
	defer server.Close()

	request, _ := http.NewRequest(http.MethodPost, server.URL+"/mcp", strings.NewReader(`{}`))
	request.Header.Set("Authorization", "Bearer alice-token")
	response, err := http.DefaultClient.Do(request)
	if err != nil {
		t.Fatal(err)
	}
	externalSession := response.Header.Get(sessionHeader)
	_ = response.Body.Close()
	if response.StatusCode != http.StatusOK || externalSession == "" {
		t.Fatalf("expected successful session, got %d and %q", response.StatusCode, externalSession)
	}
	if upstreamAuthorization != "" {
		t.Fatalf("employee token leaked upstream: %q", upstreamAuthorization)
	}

	request, _ = http.NewRequest(http.MethodPost, server.URL+"/mcp", strings.NewReader(`{}`))
	request.Header.Set("Authorization", "Bearer alice-token")
	request.Header.Set(sessionHeader, externalSession)
	response, err = http.DefaultClient.Do(request)
	if err != nil {
		t.Fatal(err)
	}
	_ = response.Body.Close()
	if response.StatusCode != http.StatusOK || upstreamSession != "envoy-session" {
		t.Fatalf("expected unwrapped upstream session, got %d and %q", response.StatusCode, upstreamSession)
	}

	request, _ = http.NewRequest(http.MethodPost, server.URL+"/mcp", strings.NewReader(`{}`))
	request.Header.Set("Authorization", "Bearer bob-token")
	request.Header.Set(sessionHeader, externalSession)
	response, err = http.DefaultClient.Do(request)
	if err != nil {
		t.Fatal(err)
	}
	defer response.Body.Close()
	if response.StatusCode != http.StatusForbidden {
		t.Fatalf("expected cross-user session rejection, got %d", response.StatusCode)
	}
	var body map[string]string
	if err := json.NewDecoder(response.Body).Decode(&body); err != nil {
		t.Fatal(err)
	}
	if body["error"] != "invalid_mcp_session" {
		t.Fatalf("unexpected error response: %#v", body)
	}

	request, _ = http.NewRequest(
		http.MethodGet,
		server.URL+"/internal/v1/authentication/mcp-clients",
		nil,
	)
	request.Header.Set("Authorization", "Bearer "+cfg.adminToken)
	response, err = http.DefaultClient.Do(request)
	if err != nil {
		t.Fatal(err)
	}
	defer response.Body.Close()
	if response.StatusCode != http.StatusOK {
		t.Fatalf("expected authenticated client list, got %d", response.StatusCode)
	}
	var clients authenticatedClientsSnapshot
	if err := json.NewDecoder(response.Body).Decode(&clients); err != nil {
		t.Fatal(err)
	}
	if len(clients.Clients) != 1 {
		t.Fatalf("expected one accepted authenticated identity, got %#v", clients.Clients)
	}
	client := clients.Clients[0]
	if client.DisplayName != "Alice" || client.Email != "alice@example.com" {
		t.Fatalf("expected employee claims, got %#v", client)
	}
	if client.RequestCount != 2 || !client.Active {
		t.Fatalf("expected two accepted requests and active status, got %#v", client)
	}
	if client.SubjectFingerprint == "alice" || client.SubjectFingerprint == "" {
		t.Fatalf("raw subject must not be exposed: %#v", client)
	}
}

func TestAuthenticatedClientListRequiresAdminToken(t *testing.T) {
	cfg := testConfig(t, "http://127.0.0.1:1/mcp")
	gateway := newMCPGateway(cfg, fakeVerifier{})
	server := httptest.NewServer(gateway.routes())
	defer server.Close()

	response, err := http.Get(server.URL + "/internal/v1/authentication/mcp-clients")
	if err != nil {
		t.Fatal(err)
	}
	defer response.Body.Close()
	if response.StatusCode != http.StatusUnauthorized {
		t.Fatalf("expected 401 without administration token, got %d", response.StatusCode)
	}
}
