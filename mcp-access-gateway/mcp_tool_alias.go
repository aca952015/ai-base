package main

import (
	"bufio"
	"bytes"
	"encoding/json"
	"fmt"
	"io"
	"net/http"
	"strconv"
	"strings"
)

const maxMCPToolListResponseBody = 2 << 20

type externalToolListAliasContextKey struct{}

type connectorToolAlias struct {
	upstream    string
	title       string
	description string
}

var connectorToolAliases = map[string]connectorToolAlias{
	"apps": {
		upstream:    "list_apps",
		title:       "Apps",
		description: "List Connector apps authorized for the current signed-in user. Use this first to discover personal, shared, and public apps, including wecom_bot.",
	},
	"connections": {
		upstream:    "list_connections",
		title:       "Connections",
		description: "List connections authorized for the current signed-in user, optionally filtered by provider service id such as wecom_bot. Use this to select a personal or shared connection.",
	},
	"search": {
		upstream:    "search_actions",
		title:       "Search",
		description: "Find Actions by capability or provider service id. First call connector__apps or connector__connections, then filter search by an authorized service.",
	},
	"guide": {
		upstream:    "get_action_guide",
		title:       "Guide",
		description: "Get parameters and examples for one Action.",
	},
	"execute": {
		upstream:    "execute_action",
		title:       "Execute",
		description: "Run one authorized Action with JSON input. Call guide first if the input shape is unclear.",
	},
}

// rewriteExternalToolAliasRequest translates only the public tool selector.
// Tool arguments and all other JSON values remain untouched.
func rewriteExternalToolAliasRequest(body []byte) ([]byte, bool) {
	decoder := json.NewDecoder(bytes.NewReader(body))
	decoder.UseNumber()
	var payload any
	if err := decoder.Decode(&payload); err != nil {
		return body, false
	}

	changed, expectsToolList := rewriteExternalToolAliasPayload(payload)
	if !changed {
		return body, expectsToolList
	}
	rewritten, err := json.Marshal(payload)
	if err != nil {
		return body, expectsToolList
	}
	return rewritten, expectsToolList
}

func rewriteExternalToolAliasPayload(payload any) (bool, bool) {
	switch typed := payload.(type) {
	case []any:
		changed := false
		expectsToolList := false
		for _, item := range typed {
			itemChanged, itemExpectsToolList := rewriteExternalToolAliasPayload(item)
			changed = itemChanged || changed
			expectsToolList = itemExpectsToolList || expectsToolList
		}
		return changed, expectsToolList
	case map[string]any:
		method, _ := typed["method"].(string)
		if method == "tools/list" {
			return false, true
		}
		if method != "tools/call" {
			return false, false
		}
		params, ok := typed["params"].(map[string]any)
		if !ok {
			return false, false
		}
		name, ok := params["name"].(string)
		if !ok {
			return false, false
		}
		rewritten := externalToInternalToolName(name)
		if rewritten == name {
			return false, false
		}
		params["name"] = rewritten
		return true, false
	default:
		return false, false
	}
}

func externalToInternalToolName(name string) string {
	switch {
	case strings.HasPrefix(name, "kb__"):
		return "mcp-rag__" + strings.TrimPrefix(name, "kb__")
	case strings.HasPrefix(name, "connector__"):
		tool := strings.TrimPrefix(name, "connector__")
		return "mcp-open-connector__" + upstreamConnectorToolName(tool)
	default:
		return name
	}
}

func internalToExternalToolName(name string) string {
	switch {
	case strings.HasPrefix(name, "mcp-rag__"):
		return "kb__" + strings.TrimPrefix(name, "mcp-rag__")
	case strings.HasPrefix(name, "mcp-open-connector__"):
		tool := strings.TrimPrefix(name, "mcp-open-connector__")
		return "connector__" + publicConnectorToolName(tool)
	default:
		return name
	}
}

func upstreamConnectorToolName(name string) string {
	if alias, ok := connectorToolAliases[name]; ok {
		return alias.upstream
	}
	return name
}

func publicConnectorToolName(name string) string {
	for public, alias := range connectorToolAliases {
		if alias.upstream == name {
			return public
		}
	}
	return name
}

func rewriteExternalToolAliasResponse(response *http.Response) error {
	if response == nil || response.Body == nil {
		return nil
	}
	if aliases, _ := response.Request.Context().Value(externalToolListAliasContextKey{}).(bool); !aliases {
		return nil
	}

	contentType := strings.ToLower(response.Header.Get("Content-Type"))
	if strings.Contains(contentType, "text/event-stream") {
		response.Body = newToolAliasSSEBody(response.Body)
		response.ContentLength = -1
		response.Header.Del("Content-Length")
		return nil
	}

	body, err := io.ReadAll(io.LimitReader(response.Body, maxMCPToolListResponseBody+1))
	if err != nil {
		return fmt.Errorf("read MCP tools/list response: %w", err)
	}
	if len(body) > maxMCPToolListResponseBody {
		return fmt.Errorf("MCP tools/list response exceeds %d bytes", maxMCPToolListResponseBody)
	}
	_ = response.Body.Close()
	if rewritten, changed := rewriteExternalToolAliasResponseJSON(body); changed {
		body = rewritten
	}
	response.Body = io.NopCloser(bytes.NewReader(body))
	response.ContentLength = int64(len(body))
	response.Header.Del("Content-Encoding")
	response.Header.Set("Content-Length", strconv.Itoa(len(body)))
	return nil
}

func rewriteExternalToolAliasResponseJSON(body []byte) ([]byte, bool) {
	decoder := json.NewDecoder(bytes.NewReader(body))
	decoder.UseNumber()
	var payload any
	if err := decoder.Decode(&payload); err != nil {
		return body, false
	}
	if !rewriteToolListPayload(payload) {
		return body, false
	}
	rewritten, err := json.Marshal(payload)
	if err != nil {
		return body, false
	}
	return rewritten, true
}

func rewriteToolListPayload(payload any) bool {
	switch typed := payload.(type) {
	case []any:
		changed := false
		for _, item := range typed {
			changed = rewriteToolListPayload(item) || changed
		}
		return changed
	case map[string]any:
		result, ok := typed["result"].(map[string]any)
		if !ok {
			return false
		}
		tools, ok := result["tools"].([]any)
		if !ok {
			return false
		}
		changed := false
		for _, item := range tools {
			tool, ok := item.(map[string]any)
			if !ok {
				continue
			}
			name, ok := tool["name"].(string)
			if !ok {
				continue
			}
			rewritten := internalToExternalToolName(name)
			if rewritten != name {
				tool["name"] = rewritten
				changed = true
			}
			if strings.HasPrefix(rewritten, "connector__") {
				publicName := strings.TrimPrefix(rewritten, "connector__")
				if alias, ok := connectorToolAliases[publicName]; ok {
					tool["title"] = alias.title
					tool["description"] = alias.description
					changed = true
				}
			}
		}
		return changed
	default:
		return false
	}
}

type toolAliasSSEBody struct {
	body        io.ReadCloser
	reader      *bufio.Reader
	pending     []byte
	terminalErr error
}

func newToolAliasSSEBody(body io.ReadCloser) *toolAliasSSEBody {
	return &toolAliasSSEBody{body: body, reader: bufio.NewReader(body)}
}

func (b *toolAliasSSEBody) Read(target []byte) (int, error) {
	for len(b.pending) == 0 && b.terminalErr == nil {
		line, err := b.reader.ReadBytes('\n')
		if len(line) > 0 {
			b.pending = rewriteToolAliasSSELine(line)
		}
		if err != nil {
			b.terminalErr = err
		}
	}
	if len(b.pending) == 0 {
		return 0, b.terminalErr
	}
	n := copy(target, b.pending)
	b.pending = b.pending[n:]
	return n, nil
}

func (b *toolAliasSSEBody) Close() error {
	return b.body.Close()
}

func rewriteToolAliasSSELine(line []byte) []byte {
	content := bytes.TrimRight(line, "\r\n")
	lineEnding := line[len(content):]
	if !bytes.HasPrefix(content, []byte("data:")) {
		return line
	}
	payload := bytes.TrimSpace(bytes.TrimPrefix(content, []byte("data:")))
	rewritten, changed := rewriteExternalToolAliasResponseJSON(payload)
	if !changed {
		return line
	}
	result := make([]byte, 0, len(rewritten)+len(lineEnding)+6)
	result = append(result, []byte("data: ")...)
	result = append(result, rewritten...)
	result = append(result, lineEnding...)
	return result
}
