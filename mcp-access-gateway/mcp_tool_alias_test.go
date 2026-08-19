package main

import (
	"bytes"
	"context"
	"io"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"
)

func TestExternalToolAliasRequestOnlyRewritesToolSelector(t *testing.T) {
	body := []byte(`[{"jsonrpc":"2.0","id":1,"method":"tools/list"},{"jsonrpc":"2.0","id":2,"method":"tools/call","params":{"name":"connector__execute","arguments":{"name":"kb__unchanged"}}},{"jsonrpc":"2.0","id":3,"method":"tools/call","params":{"name":"kb__answer","arguments":{}}}]`)
	rewritten, expectsToolList := rewriteExternalToolAliasRequest(body)
	if !expectsToolList {
		t.Fatal("expected tools/list response aliasing")
	}
	text := string(rewritten)
	for _, expected := range []string{
		`"name":"mcp-open-connector__execute_action"`,
		`"name":"mcp-rag__answer"`,
		`"arguments":{"name":"kb__unchanged"}`,
	} {
		if !strings.Contains(text, expected) {
			t.Fatalf("rewritten request is missing %s: %s", expected, text)
		}
	}
}

func TestConnectorToolAliasesMatchFormalUpstreamNames(t *testing.T) {
	tests := map[string]string{
		"apps":        "list_apps",
		"connections": "list_connections",
		"search":      "search_actions",
		"guide":       "get_action_guide",
		"execute":     "execute_action",
	}
	for public, upstream := range tests {
		if actual := upstreamConnectorToolName(public); actual != upstream {
			t.Errorf("upstreamConnectorToolName(%q) = %q, want %q", public, actual, upstream)
		}
		if actual := publicConnectorToolName(upstream); actual != public {
			t.Errorf("publicConnectorToolName(%q) = %q, want %q", upstream, actual, public)
		}
	}
}

func TestExternalToolAliasResponseRewritesJSONAndSSE(t *testing.T) {
	internal := `{"jsonrpc":"2.0","id":1,"result":{"tools":[{"name":"mcp-rag__answer"},{"name":"mcp-open-connector__execute_action","title":"Execute Action","description":"Execute one local provider action by id with a JSON input object."},{"name":"mcp-custom__read"}]}}`

	t.Run("json", func(t *testing.T) {
		response := aliasTestResponse("application/json", internal)
		if err := rewriteExternalToolAliasResponse(response); err != nil {
			t.Fatal(err)
		}
		body, err := io.ReadAll(response.Body)
		if err != nil {
			t.Fatal(err)
		}
		assertExternalToolNames(t, string(body))
	})

	t.Run("sse", func(t *testing.T) {
		response := aliasTestResponse("text/event-stream", "event: message\ndata: "+internal+"\n\n")
		if err := rewriteExternalToolAliasResponse(response); err != nil {
			t.Fatal(err)
		}
		body, err := io.ReadAll(response.Body)
		if err != nil {
			t.Fatal(err)
		}
		assertExternalToolNames(t, string(body))
		if !bytes.HasPrefix(body, []byte("event: message\ndata: ")) {
			t.Fatalf("SSE framing changed unexpectedly: %s", body)
		}
	})
}

func TestConnectorDiscoveryDescriptionsRequireIdentityScopedAppsFirst(t *testing.T) {
	internal := `{"jsonrpc":"2.0","id":1,"result":{"tools":[{"name":"mcp-open-connector__list_apps"},{"name":"mcp-open-connector__list_connections"},{"name":"mcp-open-connector__search_actions"}]}}`
	rewritten, changed := rewriteExternalToolAliasResponseJSON([]byte(internal))
	if !changed {
		t.Fatal("expected connector discovery tools to be rewritten")
	}
	body := string(rewritten)
	for _, expected := range []string{
		`"name":"connector__apps"`,
		`authorized for the current signed-in user`,
		`"name":"connector__connections"`,
		`provider service id such as wecom_bot`,
		`"name":"connector__search"`,
		`First call connector__apps or connector__connections`,
	} {
		if !strings.Contains(body, expected) {
			t.Fatalf("missing identity-aware discovery contract %q: %s", expected, body)
		}
	}
}

func TestExternalToolAliasResponseIsLimitedToToolsListRequests(t *testing.T) {
	request := httptest.NewRequest(http.MethodPost, "/mcp", nil)
	response := &http.Response{
		Request: request,
		Header:  make(http.Header),
		Body:    io.NopCloser(strings.NewReader(`{"result":{"tools":[{"name":"mcp-rag__answer"}]}}`)),
	}
	if err := rewriteExternalToolAliasResponse(response); err != nil {
		t.Fatal(err)
	}
	body, err := io.ReadAll(response.Body)
	if err != nil {
		t.Fatal(err)
	}
	if strings.Contains(string(body), "kb__answer") {
		t.Fatalf("non-tools/list response was rewritten: %s", body)
	}
}

func aliasTestResponse(contentType, body string) *http.Response {
	request := httptest.NewRequest(http.MethodPost, "/mcp", nil)
	request = request.WithContext(context.WithValue(request.Context(), externalToolListAliasContextKey{}, true))
	return &http.Response{
		Request: request,
		Header:  http.Header{"Content-Type": []string{contentType}},
		Body:    io.NopCloser(strings.NewReader(body)),
	}
}

func assertExternalToolNames(t *testing.T, body string) {
	t.Helper()
	for _, expected := range []string{
		"kb__answer",
		"connector__execute",
		"mcp-custom__read",
		`"title":"Execute"`,
		`"description":"Run one authorized Action with JSON input. Call guide first if the input shape is unclear."`,
	} {
		if !strings.Contains(body, expected) {
			t.Fatalf("missing tool name %q: %s", expected, body)
		}
	}
	for _, internal := range []string{"mcp-rag__answer", "mcp-open-connector__execute_action"} {
		if strings.Contains(body, internal) {
			t.Fatalf("internal tool name %q leaked: %s", internal, body)
		}
	}
}
