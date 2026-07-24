package main

import (
	"context"
	"encoding/json"
	"errors"
	"io"
	"net/http"
	"net/http/httptest"
	"strings"
	"sync"
	"sync/atomic"
	"testing"
)

type fakeConnectorResolver struct {
	mu           sync.Mutex
	resolveCalls []resolverCall
	listCalls    []identity
	binding      connectorBinding
	bindings     []connectorBinding
	resolveErr   error
	listErr      error
}

type resolverCall struct {
	caller  identity
	service string
}

func (r *fakeConnectorResolver) resolve(
	_ context.Context,
	caller identity,
	service string,
) (connectorBinding, error) {
	r.mu.Lock()
	defer r.mu.Unlock()
	r.resolveCalls = append(r.resolveCalls, resolverCall{caller: caller, service: service})
	return r.binding, r.resolveErr
}

func (r *fakeConnectorResolver) list(
	_ context.Context,
	caller identity,
) ([]connectorBinding, error) {
	r.mu.Lock()
	defer r.mu.Unlock()
	r.listCalls = append(r.listCalls, caller)
	return append([]connectorBinding(nil), r.bindings...), r.listErr
}

func TestConnectorToolCallInjectsIdentityBoundConnection(t *testing.T) {
	var upstreamCalls atomic.Int32
	var receivedBodies []map[string]any
	var mu sync.Mutex
	upstream := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		upstreamCalls.Add(1)
		var request map[string]any
		if err := json.NewDecoder(r.Body).Decode(&request); err != nil {
			t.Errorf("decode upstream request: %v", err)
		}
		mu.Lock()
		receivedBodies = append(receivedBodies, request)
		mu.Unlock()
		writeJSON(w, http.StatusOK, map[string]any{
			"jsonrpc": "2.0",
			"id":      request["id"],
			"result":  map[string]any{},
		})
	}))
	defer upstream.Close()

	alice := identity{issuer: "https://id.example", subject: "employee-alice"}
	resolver := &fakeConnectorResolver{
		binding: connectorBinding{
			Service:        "feishu",
			ConnectionName: "employee_f3a92b",
		},
	}
	cfg := testConfig(t, upstream.URL+"/mcp")
	gateway := newMCPGatewayWithResolver(
		cfg,
		fakeVerifier{identities: map[string]identity{"alice-token": alice}},
		resolver,
	)
	server := httptest.NewServer(gateway.routes())
	defer server.Close()

	for index, toolName := range []string{"execute_action", "open-connector__get_action_guide"} {
		requestBody := map[string]any{
			"jsonrpc": "2.0",
			"id":      index + 1,
			"method":  "tools/call",
			"params": map[string]any{
				"name": toolName,
				"arguments": map[string]any{
					"actionId":       "feishu.search_bitable_records",
					"connectionName": "default",
				},
			},
		}
		response := authenticatedMCPRequest(t, server.URL, "alice-token", requestBody)
		if response.StatusCode != http.StatusOK {
			t.Fatalf("expected proxy success, got %d", response.StatusCode)
		}
		_ = response.Body.Close()
	}

	if upstreamCalls.Load() != 2 {
		t.Fatalf("expected two upstream calls, got %d", upstreamCalls.Load())
	}
	for _, request := range receivedBodies {
		params := request["params"].(map[string]any)
		arguments := params["arguments"].(map[string]any)
		if arguments["connectionName"] != "employee_f3a92b" {
			t.Fatalf("client connection name was not replaced: %#v", arguments)
		}
	}
	if len(resolver.resolveCalls) != 2 {
		t.Fatalf("expected two resolver calls, got %#v", resolver.resolveCalls)
	}
	for _, call := range resolver.resolveCalls {
		if call.caller.issuer != alice.issuer ||
			call.caller.subject != alice.subject ||
			call.service != "feishu" {
			t.Fatalf("resolver received wrong identity or service: %#v", call)
		}
	}
}

func TestPublicNoAuthConnectorRemovesClientSelectedConnection(t *testing.T) {
	var received map[string]any
	upstream := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if err := json.NewDecoder(r.Body).Decode(&received); err != nil {
			t.Fatal(err)
		}
		writeJSON(w, http.StatusOK, map[string]any{"jsonrpc": "2.0", "id": 1, "result": map[string]any{}})
	}))
	defer upstream.Close()

	resolver := &fakeConnectorResolver{binding: connectorBinding{
		Service:        "linux_do",
		ConnectionName: "default",
		Public:         true,
	}}
	cfg := testConfig(t, upstream.URL+"/mcp")
	gateway := newMCPGatewayWithResolver(
		cfg,
		fakeVerifier{identities: map[string]identity{
			"alice-token": {issuer: "https://id.example", subject: "alice"},
		}},
		resolver,
	)
	server := httptest.NewServer(gateway.routes())
	defer server.Close()

	response := authenticatedMCPRequest(t, server.URL, "alice-token", map[string]any{
		"jsonrpc": "2.0",
		"id":      1,
		"method":  "tools/call",
		"params": map[string]any{
			"name": "mcp-open-connector__execute_action",
			"arguments": map[string]any{
				"actionId":       "linux_do.get_hot_topics",
				"connectionName": "forged_employee_alias",
			},
		},
	})
	defer response.Body.Close()
	if response.StatusCode != http.StatusOK {
		t.Fatalf("unexpected status: %d", response.StatusCode)
	}
	arguments := received["params"].(map[string]any)["arguments"].(map[string]any)
	if _, exists := arguments["connectionName"]; exists {
		t.Fatalf("public connector must not receive a client-selected alias: %#v", arguments)
	}
}

func TestListConnectionsIsServedLocallyAndFiltered(t *testing.T) {
	var upstreamCalls atomic.Int32
	upstream := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, _ *http.Request) {
		upstreamCalls.Add(1)
		w.WriteHeader(http.StatusInternalServerError)
	}))
	defer upstream.Close()

	alice := identity{issuer: "https://id.example", subject: "employee-alice"}
	resolver := &fakeConnectorResolver{
		bindings: []connectorBinding{
			{
				Service:        "feishu",
				ConnectionName: "employee_feishu",
				AuthType:       "oauth",
				DisplayName:    "Alice Feishu",
			},
			{
				Service:        "github",
				ConnectionName: "employee_github",
				Profile:        map[string]any{"login": "alice"},
			},
		},
	}
	cfg := testConfig(t, upstream.URL+"/mcp")
	gateway := newMCPGatewayWithResolver(
		cfg,
		fakeVerifier{identities: map[string]identity{"alice-token": alice}},
		resolver,
	)
	server := httptest.NewServer(gateway.routes())
	defer server.Close()

	response := authenticatedMCPRequest(t, server.URL, "alice-token", map[string]any{
		"jsonrpc": "2.0",
		"id":      "connections",
		"method":  "tools/call",
		"params": map[string]any{
			"name": "mcp-open-connector__list_connections",
			"arguments": map[string]any{
				"service": "feishu",
			},
		},
	})
	defer response.Body.Close()

	if upstreamCalls.Load() != 0 {
		t.Fatalf("list_connections must not reach upstream, got %d calls", upstreamCalls.Load())
	}
	var body struct {
		Result struct {
			IsError           bool `json:"isError"`
			StructuredContent struct {
				OK   bool             `json:"ok"`
				Data []map[string]any `json:"data"`
			} `json:"structuredContent"`
		} `json:"result"`
	}
	if err := json.NewDecoder(response.Body).Decode(&body); err != nil {
		t.Fatal(err)
	}
	if body.Result.IsError || !body.Result.StructuredContent.OK {
		t.Fatalf("expected successful local tool result: %#v", body)
	}
	if len(body.Result.StructuredContent.Data) != 1 {
		t.Fatalf("expected one service-filtered connection: %#v", body.Result.StructuredContent.Data)
	}
	connection := body.Result.StructuredContent.Data[0]
	if connection["connectionName"] != "employee_feishu" || connection["default"] != false {
		t.Fatalf("unexpected connection: %#v", connection)
	}
	if connection["id"] != "feishu:employee_feishu" {
		t.Fatalf("internal binding id must not be exposed: %#v", connection)
	}
	if len(resolver.listCalls) != 1 || resolver.listCalls[0].subject != alice.subject {
		t.Fatalf("resolver did not receive authenticated employee: %#v", resolver.listCalls)
	}
}

func TestConnectorResolutionFailuresFailClosed(t *testing.T) {
	tests := []struct {
		name         string
		resolverErr  error
		expectedCode string
	}{
		{
			name:         "employee has no binding",
			resolverErr:  errConnectorBindingNotFound,
			expectedCode: "connector_binding_required",
		},
		{
			name:         "resolver unavailable",
			resolverErr:  errConnectorResolverUnavailable,
			expectedCode: "connector_binding_resolver_unavailable",
		},
		{
			name:         "resolver returned default",
			resolverErr:  errInvalidConnectorBinding,
			expectedCode: "connector_binding_invalid",
		},
	}

	for _, test := range tests {
		t.Run(test.name, func(t *testing.T) {
			var upstreamCalls atomic.Int32
			upstream := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, _ *http.Request) {
				upstreamCalls.Add(1)
				w.WriteHeader(http.StatusOK)
			}))
			defer upstream.Close()

			resolver := &fakeConnectorResolver{resolveErr: test.resolverErr}
			cfg := testConfig(t, upstream.URL+"/mcp")
			gateway := newMCPGatewayWithResolver(
				cfg,
				fakeVerifier{identities: map[string]identity{
					"alice-token": {issuer: "https://id.example", subject: "alice"},
				}},
				resolver,
			)
			server := httptest.NewServer(gateway.routes())
			defer server.Close()

			response := authenticatedMCPRequest(t, server.URL, "alice-token", map[string]any{
				"jsonrpc": "2.0",
				"id":      1,
				"method":  "tools/call",
				"params": map[string]any{
					"name": "execute_action",
					"arguments": map[string]any{
						"actionId":       "feishu.search_bitable_records",
						"connectionName": "attacker-selected",
					},
				},
			})
			defer response.Body.Close()

			if upstreamCalls.Load() != 0 {
				t.Fatalf("failed authorization must not reach upstream")
			}
			payload, err := io.ReadAll(response.Body)
			if err != nil {
				t.Fatal(err)
			}
			if !strings.Contains(string(payload), test.expectedCode) ||
				!strings.Contains(string(payload), `"isError":true`) {
				t.Fatalf("unexpected fail-closed response: %s", payload)
			}
			if errors.Is(test.resolverErr, errConnectorBindingNotFound) {
				if !strings.Contains(string(payload), "open_account_binding") ||
					!strings.Contains(string(payload), "/account") ||
					strings.Contains(string(payload), "Connector configuration") {
					t.Fatalf("binding error must direct employees to account binding: %s", payload)
				}
			}
		})
	}
}

func TestProtectedConnectorBatchFailsClosed(t *testing.T) {
	var upstreamCalls atomic.Int32
	upstream := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, _ *http.Request) {
		upstreamCalls.Add(1)
		w.WriteHeader(http.StatusOK)
	}))
	defer upstream.Close()

	cfg := testConfig(t, upstream.URL+"/mcp")
	gateway := newMCPGatewayWithResolver(
		cfg,
		fakeVerifier{identities: map[string]identity{
			"alice-token": {issuer: "https://id.example", subject: "alice"},
		}},
		&fakeConnectorResolver{
			binding: connectorBinding{Service: "feishu", ConnectionName: "employee_feishu"},
		},
	)
	server := httptest.NewServer(gateway.routes())
	defer server.Close()

	response := authenticatedMCPRequest(t, server.URL, "alice-token", []any{
		map[string]any{
			"jsonrpc": "2.0",
			"id":      1,
			"method":  "tools/call",
			"params": map[string]any{
				"name":      "execute_action",
				"arguments": map[string]any{"actionId": "feishu.list_records"},
			},
		},
		map[string]any{
			"jsonrpc": "2.0",
			"id":      2,
			"method":  "tools/list",
		},
	})
	defer response.Body.Close()

	if upstreamCalls.Load() != 0 {
		t.Fatalf("protected batch must not reach upstream")
	}
	payload, err := io.ReadAll(response.Body)
	if err != nil {
		t.Fatal(err)
	}
	if !strings.Contains(string(payload), "Batched OpenConnector tool calls") {
		t.Fatalf("unexpected batch response: %s", payload)
	}
}

func TestUnprotectedMCPToolCallPassesThroughUnchanged(t *testing.T) {
	var received map[string]any
	upstream := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if err := json.NewDecoder(r.Body).Decode(&received); err != nil {
			t.Errorf("decode request: %v", err)
		}
		writeJSON(w, http.StatusOK, map[string]any{"jsonrpc": "2.0", "id": 1, "result": map[string]any{}})
	}))
	defer upstream.Close()

	cfg := testConfig(t, upstream.URL+"/mcp")
	gateway := newMCPGatewayWithResolver(
		cfg,
		fakeVerifier{identities: map[string]identity{
			"alice-token": {issuer: "https://id.example", subject: "alice"},
		}},
		&fakeConnectorResolver{resolveErr: errors.New("must not be called")},
	)
	server := httptest.NewServer(gateway.routes())
	defer server.Close()

	response := authenticatedMCPRequest(t, server.URL, "alice-token", map[string]any{
		"jsonrpc": "2.0",
		"id":      1,
		"method":  "tools/call",
		"params": map[string]any{
			"name":      "open-connector__search_actions",
			"arguments": map[string]any{"query": "bitable"},
		},
	})
	defer response.Body.Close()

	params := received["params"].(map[string]any)
	arguments := params["arguments"].(map[string]any)
	if arguments["query"] != "bitable" {
		t.Fatalf("ordinary MCP request changed: %#v", received)
	}
}

func authenticatedMCPRequest(
	t *testing.T,
	serverURL string,
	token string,
	payload any,
) *http.Response {
	t.Helper()
	body, err := json.Marshal(payload)
	if err != nil {
		t.Fatal(err)
	}
	request, err := http.NewRequest(http.MethodPost, serverURL+"/mcp", strings.NewReader(string(body)))
	if err != nil {
		t.Fatal(err)
	}
	request.Header.Set("Authorization", "Bearer "+token)
	request.Header.Set("Content-Type", "application/json")
	response, err := http.DefaultClient.Do(request)
	if err != nil {
		t.Fatal(err)
	}
	return response
}
