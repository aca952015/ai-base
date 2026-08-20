package main

import (
	"encoding/json"
	"io"
	"net/http"
	"net/http/httptest"
	"os"
	"path/filepath"
	"strings"
	"sync"
	"testing"
)

func TestStatelessBackendReceivesSyntheticSessionWithoutLeakingItUpstream(t *testing.T) {
	var mu sync.Mutex
	var sessions []string
	var authorizations []string
	upstream := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		mu.Lock()
		sessions = append(sessions, r.Header.Get(mcpSessionHeader))
		authorizations = append(authorizations, r.Header.Get("Authorization"))
		mu.Unlock()
		w.Header().Set("Content-Type", "application/json; charset=utf-8")
		_, _ = io.WriteString(w, `{"jsonrpc":"2.0","id":1,"result":{"protocolVersion":"2025-06-18","capabilities":{"tools":{}},"serverInfo":{"name":"stateless","version":"1"}}}`)
	}))
	defer upstream.Close()

	server := newTestAdapterServer(t, upstream.URL, "Authorization", "private-token")
	defer server.Close()

	initialized := postAdapterMCP(t, server.URL, "", `{"jsonrpc":"2.0","id":1,"method":"initialize","params":{}}`)
	sessionID := initialized.Header.Get(mcpSessionHeader)
	if contentType := initialized.Header.Get("Content-Type"); contentType != "application/json" {
		t.Fatalf("JSON media type was not normalized for Envoy: %q", contentType)
	}
	_ = initialized.Body.Close()
	if !strings.HasPrefix(sessionID, statelessSessionPrefix) {
		t.Fatalf("expected a synthetic stateless session, got %q", sessionID)
	}

	listed := postAdapterMCP(t, server.URL, sessionID, `{"jsonrpc":"2.0","id":2,"method":"tools/list","params":{}}`)
	_ = listed.Body.Close()
	if listed.StatusCode != http.StatusOK {
		t.Fatalf("unexpected tools/list status: %d", listed.StatusCode)
	}

	mu.Lock()
	defer mu.Unlock()
	if len(sessions) != 2 || sessions[0] != "" || sessions[1] != "" {
		t.Fatalf("synthetic session leaked to stateless upstream: %v", sessions)
	}
	if len(authorizations) != 2 || authorizations[0] != "Bearer private-token" || authorizations[1] != "Bearer private-token" {
		t.Fatalf("configured authorization was not injected: %v", authorizations)
	}
}

func TestStatefulBackendSessionIsPreserved(t *testing.T) {
	var receivedSession string
	upstream := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		var request struct {
			Method string `json:"method"`
		}
		_ = json.NewDecoder(r.Body).Decode(&request)
		if request.Method == "initialize" {
			w.Header().Set(mcpSessionHeader, "real-upstream-session")
		} else {
			receivedSession = r.Header.Get(mcpSessionHeader)
		}
		w.Header().Set("Content-Type", "application/json")
		_, _ = io.WriteString(w, `{"jsonrpc":"2.0","id":1,"result":{}}`)
	}))
	defer upstream.Close()

	server := newTestAdapterServer(t, upstream.URL, "X-API-Key", "secret")
	defer server.Close()
	initialized := postAdapterMCP(t, server.URL, "", `{"jsonrpc":"2.0","id":1,"method":"initialize","params":{}}`)
	sessionID := initialized.Header.Get(mcpSessionHeader)
	_ = initialized.Body.Close()
	if sessionID != "real-upstream-session" {
		t.Fatalf("real upstream session changed: %q", sessionID)
	}
	listed := postAdapterMCP(t, server.URL, sessionID, `{"jsonrpc":"2.0","id":2,"method":"tools/list","params":{}}`)
	_ = listed.Body.Close()
	if receivedSession != sessionID {
		t.Fatalf("upstream session was not forwarded: got %q, want %q", receivedSession, sessionID)
	}
}

func TestAdapterRejectsUnknownNamespacesAndInvalidSyntheticSessions(t *testing.T) {
	upstreamCalls := 0
	upstream := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, _ *http.Request) {
		upstreamCalls++
		w.WriteHeader(http.StatusOK)
	}))
	defer upstream.Close()
	server := newTestAdapterServer(t, upstream.URL, "Authorization", "")
	defer server.Close()

	unknown := postAdapterMCPAt(t, server.URL, "unknown", "", `{"jsonrpc":"2.0","id":1,"method":"initialize"}`)
	_ = unknown.Body.Close()
	if unknown.StatusCode != http.StatusNotFound {
		t.Fatalf("unknown namespace returned %d", unknown.StatusCode)
	}
	invalid := postAdapterMCP(t, server.URL, statelessSessionPrefix+"invalid", `{"jsonrpc":"2.0","id":2,"method":"tools/list"}`)
	_ = invalid.Body.Close()
	if invalid.StatusCode != http.StatusBadRequest {
		t.Fatalf("invalid synthetic session returned %d", invalid.StatusCode)
	}
	if upstreamCalls != 0 {
		t.Fatalf("rejected requests reached upstream %d times", upstreamCalls)
	}
}

func TestStatelessDeleteTerminatesLocally(t *testing.T) {
	upstreamCalls := 0
	upstream := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, _ *http.Request) {
		upstreamCalls++
		w.Header().Set("Content-Type", "application/json")
		_, _ = io.WriteString(w, `{"jsonrpc":"2.0","id":1,"result":{}}`)
	}))
	defer upstream.Close()
	adapter, server := newTestAdapter(t, upstream.URL, "Authorization", "")
	defer server.Close()
	sessionID, err := adapter.sessions.seal("mcd")
	if err != nil {
		t.Fatal(err)
	}
	request, err := http.NewRequest(http.MethodDelete, server.URL+"/internal/v1/mcp-backends/mcd", nil)
	if err != nil {
		t.Fatal(err)
	}
	request.Header.Set(mcpSessionHeader, sessionID)
	response, err := http.DefaultClient.Do(request)
	if err != nil {
		t.Fatal(err)
	}
	_ = response.Body.Close()
	if response.StatusCode != http.StatusNoContent || upstreamCalls != 0 {
		t.Fatalf("stateless delete status=%d upstream_calls=%d", response.StatusCode, upstreamCalls)
	}
}

func newTestAdapterServer(t *testing.T, upstreamURL, authHeader, secret string) *httptest.Server {
	_, server := newTestAdapter(t, upstreamURL, authHeader, secret)
	return server
}

func newTestAdapter(t *testing.T, upstreamURL, authHeader, secret string) (*mcpBackendAdapter, *httptest.Server) {
	t.Helper()
	directory := t.TempDir()
	secrets := filepath.Join(directory, "secrets")
	if err := os.Mkdir(secrets, 0o700); err != nil {
		t.Fatal(err)
	}
	stored := map[string]any{"servers": []map[string]any{{
		"id": "mcp-mcd", "name": "麦当劳", "namespace": "mcd", "url": upstreamURL,
		"enabled": true, "authHeader": authHeader,
	}}}
	raw, err := json.Marshal(stored)
	if err != nil {
		t.Fatal(err)
	}
	serversPath := filepath.Join(directory, "servers.json")
	if err := os.WriteFile(serversPath, raw, 0o600); err != nil {
		t.Fatal(err)
	}
	if secret != "" {
		if err := os.WriteFile(filepath.Join(secrets, "mcp-mcd.key"), []byte(secret), 0o600); err != nil {
			t.Fatal(err)
		}
	}
	adapter := newMCPBackendAdapter(config{
		serversPath: serversPath,
		secretsPath: secrets,
		signingKey:  []byte("test-mcp-adapter-signing-key-32-bytes-minimum"),
	})
	return adapter, httptest.NewServer(adapter.routes())
}

func postAdapterMCP(t *testing.T, baseURL, sessionID, body string) *http.Response {
	return postAdapterMCPAt(t, baseURL, "mcd", sessionID, body)
}

func postAdapterMCPAt(t *testing.T, baseURL, namespace, sessionID, body string) *http.Response {
	t.Helper()
	request, err := http.NewRequest(http.MethodPost, baseURL+"/internal/v1/mcp-backends/"+namespace, strings.NewReader(body))
	if err != nil {
		t.Fatal(err)
	}
	request.Header.Set("Content-Type", "application/json")
	request.Header.Set("Accept", "application/json, text/event-stream")
	if sessionID != "" {
		request.Header.Set(mcpSessionHeader, sessionID)
	}
	response, err := http.DefaultClient.Do(request)
	if err != nil {
		t.Fatal(err)
	}
	return response
}
