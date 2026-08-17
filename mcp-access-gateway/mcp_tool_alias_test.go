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
		`"name":"mcp-open-connector__execute"`,
		`"name":"mcp-rag__answer"`,
		`"arguments":{"name":"kb__unchanged"}`,
	} {
		if !strings.Contains(text, expected) {
			t.Fatalf("rewritten request is missing %s: %s", expected, text)
		}
	}
}

func TestExternalToolAliasResponseRewritesJSONAndSSE(t *testing.T) {
	internal := `{"jsonrpc":"2.0","id":1,"result":{"tools":[{"name":"mcp-rag__answer"},{"name":"mcp-open-connector__execute"},{"name":"mcp-custom__read"}]}}`

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
	for _, expected := range []string{"kb__answer", "connector__execute", "mcp-custom__read"} {
		if !strings.Contains(body, expected) {
			t.Fatalf("missing tool name %q: %s", expected, body)
		}
	}
	for _, internal := range []string{"mcp-rag__answer", "mcp-open-connector__execute"} {
		if strings.Contains(body, internal) {
			t.Fatalf("internal tool name %q leaked: %s", internal, body)
		}
	}
}
