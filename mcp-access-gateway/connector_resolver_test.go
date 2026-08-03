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
	var requests []map[string]any
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if r.Header.Get("Authorization") != "Bearer internal-resolver-token" {
			t.Errorf("unexpected authorization header: %q", r.Header.Get("Authorization"))
		}
		var request map[string]any
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
		issuer:   "https://broker.example/oauth",
		subject:  "opaque-broker-subject",
		email:    "Employee@Example.com",
		clientID: "workbuddy",
		groups:   []string{"sales", "employees"},
	}

	binding, err := resolver.resolve(
		context.Background(),
		caller,
		"feishu",
		"employee_feishu",
		"feishu.search_bitable_records",
	)
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
		if request["clientId"] != "workbuddy" {
			t.Fatalf("resolver must forward the verified client id: %#v", request)
		}
		groups, ok := request["groups"].([]any)
		if !ok || len(groups) != 2 || groups[0] != "sales" {
			t.Fatalf("resolver must forward verified groups: %#v", request)
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
			"",
			"",
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
			"",
			"",
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
		"",
		"linux_do.get_hot_topics",
	)
	if err != nil {
		t.Fatal(err)
	}
	if !binding.Public || binding.ConnectionName != "default" {
		t.Fatalf("unexpected public binding: %#v", binding)
	}
}

func TestHTTPConnectorResolverMapsPolicyDecisions(t *testing.T) {
	tests := []struct {
		name     string
		status   int
		code     string
		expected error
	}{
		{name: "connector denied", status: http.StatusForbidden, code: "connector_not_authorized", expected: errConnectorNotAuthorized},
		{name: "action denied", status: http.StatusForbidden, code: "action_not_authorized", expected: errConnectorActionNotAuthorized},
		{name: "selection required", status: http.StatusConflict, code: "connector_selection_required", expected: errConnectorSelectionRequired},
	}
	for _, test := range tests {
		t.Run(test.name, func(t *testing.T) {
			server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, _ *http.Request) {
				writeJSON(w, test.status, map[string]string{"code": test.code})
			}))
			defer server.Close()
			endpoint, _ := url.Parse(server.URL)
			resolver := &httpConnectorBindingResolver{endpoint: endpoint, token: "token", client: server.Client()}
			_, err := resolver.resolve(
				context.Background(),
				identity{issuer: "https://id.example", subject: "alice"},
				"wecom_bot",
				"wecom_sales_bot",
				"wecom_bot.send_message",
			)
			if !errors.Is(err, test.expected) {
				t.Fatalf("expected %v, got %v", test.expected, err)
			}
		})
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
