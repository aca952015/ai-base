package main

import (
	"encoding/json"
	"io"
	"net/http"
	"net/http/httptest"
	"strings"
	"sync"
	"testing"
)

func TestCustomMCPToolsCollapseToTwoToolsPerNamespace(t *testing.T) {
	body := []byte(`{
		"jsonrpc":"2.0",
		"id":1,
		"result":{"tools":[
			{"name":"mcp-rag__answer"},
			{"name":"mcp-mcd__query-order","description":"Query one order"},
			{"name":"mcp-mcd__delivery-query-stores"},
			{"name":"mcp-github__search_repositories"}
		]}
	}`)
	rewritten, changed := rewriteExternalToolAliasResponseJSON(body)
	if !changed {
		t.Fatal("expected public tool list to be rewritten")
	}

	var response struct {
		Result struct {
			Tools []struct {
				Name string `json:"name"`
			} `json:"tools"`
		} `json:"result"`
	}
	if err := json.Unmarshal(rewritten, &response); err != nil {
		t.Fatal(err)
	}
	names := make([]string, 0, len(response.Result.Tools))
	for _, tool := range response.Result.Tools {
		names = append(names, tool.Name)
	}
	want := []string{"kb__answer", "mcd__tools", "mcd__execute", "github__tools", "github__execute"}
	if strings.Join(names, ",") != strings.Join(want, ",") {
		t.Fatalf("unexpected public tools: got %v, want %v", names, want)
	}
}

func TestCustomMCPWrapperDescriptionsReflectConfiguredServiceAndAllowedTools(t *testing.T) {
	body := []byte(`{
		"jsonrpc":"2.0",
		"id":1,
		"result":{"tools":[
			{"name":"mcp-mcd__query-order","description":"查询麦当劳订单状态"},
			{"name":"mcp-mcd__delivery-query-stores","description":"查询可配送门店"}
		]}
	}`)
	rewritten, changed := rewriteExternalToolAliasResponseJSONWithMetadata(body, map[string]customMCPMetadata{
		"mcd": {displayName: "麦当劳"},
	})
	if !changed {
		t.Fatal("expected configured custom MCP tools to be compacted")
	}
	text := string(rewritten)
	for _, expected := range []string{
		`"name":"mcd__tools"`,
		`"title":"麦当劳 Tools"`,
		`2 tools currently allowed`,
		`configured MCP service \"麦当劳\" (namespace mcd)`,
		`查询麦当劳订单状态`,
		`"name":"mcd__execute"`,
		`Call mcd__tools first`,
	} {
		if !strings.Contains(text, expected) {
			t.Fatalf("dynamic wrapper description is missing %q: %s", expected, text)
		}
	}
}

func TestConfiguredCustomMCPStillExposesTwoToolsWhenUpstreamCatalogIsEmpty(t *testing.T) {
	body := []byte(`{
		"jsonrpc":"2.0",
		"id":1,
		"result":{"tools":[{"name":"mcp-rag__answer"}]}
	}`)
	rewritten, changed := rewriteExternalToolAliasResponseJSONWithMetadata(body, map[string]customMCPMetadata{
		"mcd": {displayName: "麦当劳"},
	})
	if !changed {
		t.Fatal("expected configured custom MCP tools to be generated")
	}
	text := string(rewritten)
	for _, expected := range []string{
		`"name":"mcd__tools"`,
		`"name":"mcd__execute"`,
		`0 tools currently allowed`,
		`configured MCP service \"麦当劳\" (namespace mcd)`,
	} {
		if !strings.Contains(text, expected) {
			t.Fatalf("configured custom MCP wrapper is missing %q: %s", expected, text)
		}
	}
}

func TestCustomMCPListReturnsOnlyRequestedNamespaceWithBoundedResults(t *testing.T) {
	body := []byte(`{
		"jsonrpc":"2.0",
		"id":7,
		"result":{"tools":[
			{"name":"mcp-mcd__store-status","description":"Read store status","inputSchema":{"type":"object"}},
			{"name":"mcp-github__search-order","description":"Not an mcd tool"},
			{"name":"mcp-mcd__query-order","title":"Query Order","description":"Find an order","inputSchema":{"type":"object","required":["orderId"]}},
			{"name":"mcp-mcd__cancel-order","description":"Cancel an order"}
		]}
	}`)
	rewritten, changed := rewriteCustomMCPListResponseJSON(body, customMCPListOptions{
		namespace: "mcd",
		query:     "order",
		limit:     1,
	})
	if !changed {
		t.Fatal("expected custom MCP list response rewrite")
	}

	var response struct {
		Result struct {
			StructuredContent struct {
				OK        bool   `json:"ok"`
				Namespace string `json:"namespace"`
				Tools     []struct {
					Name        string         `json:"name"`
					InputSchema map[string]any `json:"inputSchema"`
				} `json:"tools"`
				Pagination struct {
					Total      int `json:"total"`
					NextOffset int `json:"nextOffset"`
				} `json:"pagination"`
			} `json:"structuredContent"`
		} `json:"result"`
	}
	if err := json.Unmarshal(rewritten, &response); err != nil {
		t.Fatal(err)
	}
	content := response.Result.StructuredContent
	if !content.OK || content.Namespace != "mcd" || content.Pagination.Total != 2 || content.Pagination.NextOffset != 1 {
		t.Fatalf("unexpected list metadata: %#v", content)
	}
	if len(content.Tools) != 1 || content.Tools[0].Name != "cancel-order" {
		t.Fatalf("expected sorted, bounded mcd results, got %#v", content.Tools)
	}
	if strings.Contains(string(rewritten), "mcp-mcd__") || strings.Contains(string(rewritten), "mcp-github__") {
		t.Fatalf("internal tool namespace leaked: %s", rewritten)
	}
}

func TestCustomMCPListResponseRewritesSSEWithoutChangingFraming(t *testing.T) {
	internal := `{"jsonrpc":"2.0","id":7,"result":{"tools":[{"name":"mcp-mcd__query-order","inputSchema":{"type":"object"}},{"name":"mcp-github__search_repositories"}]}}`
	request := httptest.NewRequest(http.MethodPost, "/mcp", nil)
	response := &http.Response{
		Request: request,
		Header:  http.Header{"Content-Type": []string{"text/event-stream"}},
		Body:    io.NopCloser(strings.NewReader("event: message\ndata: " + internal + "\n\n")),
	}
	if err := rewriteCustomMCPListResponse(response, customMCPListOptions{namespace: "mcd", limit: 20}); err != nil {
		t.Fatal(err)
	}
	body, err := io.ReadAll(response.Body)
	if err != nil {
		t.Fatal(err)
	}
	if !strings.HasPrefix(string(body), "event: message\ndata: ") {
		t.Fatalf("SSE framing changed unexpectedly: %s", body)
	}
	if !strings.Contains(string(body), `"name":"query-order"`) || strings.Contains(string(body), "github") {
		t.Fatalf("SSE discovery response was not namespace-scoped: %s", body)
	}
}

func TestCustomMCPExecuteRewritesOnlyTheSelectedNamespace(t *testing.T) {
	original := []byte(`{"jsonrpc":"2.0","id":9,"method":"tools/call","params":{"name":"mcd__execute","arguments":{"name":"query-order","arguments":{"orderId":"123"}}}}`)
	filtered := filterCustomMCPRequest(original)
	if filtered.handled || filtered.listOptions != nil {
		t.Fatalf("execute should be forwarded after rewrite: %#v", filtered)
	}
	var request map[string]any
	if err := json.Unmarshal(filtered.body, &request); err != nil {
		t.Fatal(err)
	}
	params := request["params"].(map[string]any)
	if params["name"] != "mcp-mcd__query-order" {
		t.Fatalf("unexpected upstream selector: %#v", params)
	}
	arguments := params["arguments"].(map[string]any)
	if arguments["orderId"] != "123" {
		t.Fatalf("tool arguments changed: %#v", arguments)
	}

	for _, reserved := range []string{"connector__execute", "kb__execute", "mcp-open-connector__execute"} {
		body := []byte(`{"jsonrpc":"2.0","id":1,"method":"tools/call","params":{"name":"` + reserved + `","arguments":{}}}`)
		result := filterCustomMCPRequest(body)
		if string(result.body) != string(body) || result.handled {
			t.Fatalf("reserved tool %q was intercepted by custom MCP proxy", reserved)
		}
	}
}

func TestCustomMCPProxyRejectsInvalidCallsLocally(t *testing.T) {
	invalid := filterCustomMCPRequest([]byte(`{"jsonrpc":"2.0","id":1,"method":"tools/call","params":{"name":"mcd__execute","arguments":{"name":"../query-order"}}}`))
	if !invalid.handled {
		t.Fatal("expected invalid custom tool name to be rejected")
	}
	payload, _ := json.Marshal(invalid.localResponse)
	if !strings.Contains(string(payload), "invalid_custom_mcp_tool") {
		t.Fatalf("unexpected invalid tool response: %s", payload)
	}

	batch := filterCustomMCPRequest([]byte(`[{"jsonrpc":"2.0","id":1,"method":"tools/call","params":{"name":"mcd__tools","arguments":{}}}]`))
	if !batch.handled {
		t.Fatal("expected custom MCP batch to be rejected")
	}
	payload, _ = json.Marshal(batch.localResponse)
	if !strings.Contains(string(payload), "Batched custom MCP proxy calls are not supported") {
		t.Fatalf("unexpected batch response: %s", payload)
	}
}

func TestCustomMCPProxyGatewayListAndExecute(t *testing.T) {
	var mu sync.Mutex
	var upstreamRequests []map[string]any
	upstream := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		var request map[string]any
		if err := json.NewDecoder(r.Body).Decode(&request); err != nil {
			t.Errorf("decode upstream request: %v", err)
			return
		}
		mu.Lock()
		upstreamRequests = append(upstreamRequests, request)
		mu.Unlock()
		w.Header().Set("Content-Type", "application/json")
		if request["method"] == "tools/list" {
			writeJSON(w, http.StatusOK, map[string]any{
				"jsonrpc": "2.0",
				"id":      request["id"],
				"result": map[string]any{"tools": []any{
					map[string]any{"name": "mcp-mcd__query-order", "inputSchema": map[string]any{"type": "object"}},
					map[string]any{"name": "mcp-mcd__list-stores", "inputSchema": map[string]any{"type": "object"}},
					map[string]any{"name": "mcp-github__search_repositories"},
				}},
			})
			return
		}
		writeJSON(w, http.StatusOK, map[string]any{
			"jsonrpc": "2.0",
			"id":      request["id"],
			"result":  map[string]any{"content": []any{map[string]any{"type": "text", "text": "ok"}}},
		})
	}))
	defer upstream.Close()

	cfg := testConfig(t, upstream.URL+"/mcp")
	gateway := newMCPGatewayWithResolver(
		cfg,
		fakeVerifier{identities: map[string]identity{
			"alice-token": {issuer: "https://id.example", subject: "alice"},
		}},
		&fakeConnectorResolver{},
	)
	server := httptest.NewServer(gateway.routes())
	defer server.Close()

	listed := authenticatedMCPRequest(t, server.URL, "alice-token", map[string]any{
		"jsonrpc": "2.0",
		"id":      1,
		"method":  "tools/list",
	})
	listedBody, err := io.ReadAll(listed.Body)
	_ = listed.Body.Close()
	if err != nil {
		t.Fatal(err)
	}
	for _, expected := range []string{"mcd__tools", "mcd__execute", "github__tools", "github__execute"} {
		if !strings.Contains(string(listedBody), expected) {
			t.Fatalf("public tools/list is missing %q: %s", expected, listedBody)
		}
	}
	if strings.Contains(string(listedBody), "mcp-mcd__query-order") {
		t.Fatalf("raw custom tools leaked to the client: %s", listedBody)
	}

	discovered := authenticatedMCPRequest(t, server.URL, "alice-token", map[string]any{
		"jsonrpc": "2.0",
		"id":      2,
		"method":  "tools/call",
		"params": map[string]any{
			"name":      "mcd__tools",
			"arguments": map[string]any{"query": "order"},
		},
	})
	discoveredBody, err := io.ReadAll(discovered.Body)
	_ = discovered.Body.Close()
	if err != nil {
		t.Fatal(err)
	}
	if !strings.Contains(string(discoveredBody), `"name":"query-order"`) || strings.Contains(string(discoveredBody), "github") {
		t.Fatalf("namespace discovery returned the wrong tools: %s", discoveredBody)
	}

	executed := authenticatedMCPRequest(t, server.URL, "alice-token", map[string]any{
		"jsonrpc": "2.0",
		"id":      3,
		"method":  "tools/call",
		"params": map[string]any{
			"name": "mcd__execute",
			"arguments": map[string]any{
				"name":      "query-order",
				"arguments": map[string]any{"orderId": "123"},
			},
		},
	})
	_ = executed.Body.Close()

	mu.Lock()
	defer mu.Unlock()
	last := upstreamRequests[len(upstreamRequests)-1]
	params := last["params"].(map[string]any)
	if params["name"] != "mcp-mcd__query-order" {
		t.Fatalf("execute reached the wrong upstream tool: %#v", last)
	}
	if params["arguments"].(map[string]any)["orderId"] != "123" {
		t.Fatalf("execute changed upstream arguments: %#v", last)
	}
}
