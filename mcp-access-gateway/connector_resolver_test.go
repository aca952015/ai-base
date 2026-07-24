package main

import (
	"context"
	"encoding/json"
	"errors"
	"net/http"
	"net/http/httptest"
	"net/url"
	"testing"
)

func TestHTTPConnectorResolverSendsOpaqueIdentityAndToken(t *testing.T) {
	var requests []map[string]string
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if r.Header.Get("Authorization") != "Bearer internal-resolver-token" {
			t.Errorf("unexpected authorization header: %q", r.Header.Get("Authorization"))
		}
		var request map[string]string
		if err := json.NewDecoder(r.Body).Decode(&request); err != nil {
			t.Fatal(err)
		}
		requests = append(requests, request)

		if request["service"] == "" {
			writeJSON(w, http.StatusOK, map[string]any{
				"connections": []map[string]any{
					{
						"service":        "feishu",
						"connectionName": "employee_feishu",
					},
				},
			})
			return
		}
		writeJSON(w, http.StatusOK, map[string]any{
			"connectionName": "employee_feishu",
			"service":        request["service"],
		})
	}))
	defer server.Close()

	endpoint, err := url.Parse(server.URL)
	if err != nil {
		t.Fatal(err)
	}
	resolver := &httpConnectorBindingResolver{
		endpoint: endpoint,
		token:    "internal-resolver-token",
		client:   server.Client(),
	}
	caller := identity{
		issuer:  "https://broker.example/oauth",
		subject: "opaque-broker-subject",
		email:   "Employee@Example.com",
	}

	binding, err := resolver.resolve(context.Background(), caller, "feishu")
	if err != nil {
		t.Fatal(err)
	}
	if binding.ConnectionName != "employee_feishu" {
		t.Fatalf("unexpected binding: %#v", binding)
	}
	bindings, err := resolver.list(context.Background(), caller)
	if err != nil {
		t.Fatal(err)
	}
	if len(bindings) != 1 || bindings[0].Service != "feishu" {
		t.Fatalf("unexpected list: %#v", bindings)
	}

	if len(requests) != 2 {
		t.Fatalf("expected two resolver requests, got %#v", requests)
	}
	for _, request := range requests {
		if request["issuer"] != caller.issuer || request["subject"] != caller.subject {
			t.Fatalf("resolver identity mismatch: %#v", request)
		}
		if request["email"] != "employee@example.com" {
			t.Fatalf("resolver must forward the verified normalized email: %#v", request)
		}
	}
	if requests[0]["service"] != "feishu" || requests[1]["service"] != "" {
		t.Fatalf("resolve/list contract mismatch: %#v", requests)
	}
}

func TestHTTPConnectorResolverRejectsDefaultAndFailsClosed(t *testing.T) {
	t.Run("default connection", func(t *testing.T) {
		server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, _ *http.Request) {
			writeJSON(w, http.StatusOK, map[string]string{
				"service":        "feishu",
				"connectionName": "default",
			})
		}))
		defer server.Close()

		endpoint, _ := url.Parse(server.URL)
		resolver := &httpConnectorBindingResolver{
			endpoint: endpoint,
			token:    "token",
			client:   server.Client(),
		}
		_, err := resolver.resolve(
			context.Background(),
			identity{issuer: "https://id.example", subject: "alice"},
			"feishu",
		)
		if !errors.Is(err, errInvalidConnectorBinding) {
			t.Fatalf("expected invalid binding, got %v", err)
		}
	})

	t.Run("not found", func(t *testing.T) {
		server := httptest.NewServer(http.NotFoundHandler())
		defer server.Close()

		endpoint, _ := url.Parse(server.URL)
		resolver := &httpConnectorBindingResolver{
			endpoint: endpoint,
			token:    "token",
			client:   server.Client(),
		}
		_, err := resolver.resolve(
			context.Background(),
			identity{issuer: "https://id.example", subject: "alice"},
			"feishu",
		)
		if !errors.Is(err, errConnectorBindingNotFound) {
			t.Fatalf("expected binding not found, got %v", err)
		}
	})
}

func TestHTTPConnectorResolverAcceptsExplicitPublicNoAuthConnection(t *testing.T) {
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, _ *http.Request) {
		writeJSON(w, http.StatusOK, map[string]any{
			"service":        "linux_do",
			"connectionName": "default",
			"public":         true,
		})
	}))
	defer server.Close()

	endpoint, _ := url.Parse(server.URL)
	resolver := &httpConnectorBindingResolver{
		endpoint: endpoint,
		token:    "token",
		client:   server.Client(),
	}
	binding, err := resolver.resolve(
		context.Background(),
		identity{issuer: "https://id.example", subject: "alice"},
		"linux_do",
	)
	if err != nil {
		t.Fatal(err)
	}
	if !binding.Public || binding.ConnectionName != "default" {
		t.Fatalf("unexpected public binding: %#v", binding)
	}
}

func TestLoadConfigValidatesConnectorResolver(t *testing.T) {
	t.Run("invalid URL", func(t *testing.T) {
		t.Setenv("MCP_CONNECTOR_BINDING_RESOLVER_URL", "relative/path")
		_, err := loadConfig()
		if err == nil || err.Error() != "MCP_CONNECTOR_BINDING_RESOLVER_URL must be an absolute HTTP(S) URL" {
			t.Fatalf("expected resolver URL validation, got %v", err)
		}
	})

	t.Run("empty token", func(t *testing.T) {
		t.Setenv("MCP_CONNECTOR_BINDING_RESOLVER_URL", "http://ai-console:3000/api/internal/connector-bindings/resolve")
		t.Setenv("MCP_CONNECTOR_BINDING_RESOLVER_TOKEN", "")
		_, err := loadConfig()
		if err == nil || err.Error() != "MCP_CONNECTOR_BINDING_RESOLVER_TOKEN must not be empty" {
			t.Fatalf("expected resolver token validation, got %v", err)
		}
	})
}
