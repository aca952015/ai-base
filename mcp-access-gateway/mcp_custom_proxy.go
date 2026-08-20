package main

import (
	"bytes"
	"encoding/json"
	"fmt"
	"io"
	"net/http"
	"sort"
	"strconv"
	"strings"
)

const (
	defaultCustomMCPListLimit = 20
	maxCustomMCPListLimit     = 100
)

type customMCPListContextKey struct{}

type customMCPListOptions struct {
	namespace string
	query     string
	offset    int
	limit     int
}

type customMCPRequestFilterResult struct {
	body          []byte
	localResponse any
	handled       bool
	listOptions   *customMCPListOptions
}

func filterCustomMCPRequest(body []byte) customMCPRequestFilterResult {
	decoder := json.NewDecoder(bytes.NewReader(body))
	decoder.UseNumber()
	var payload any
	if err := decoder.Decode(&payload); err != nil {
		return customMCPRequestFilterResult{body: body}
	}

	switch typed := payload.(type) {
	case map[string]any:
		return filterSingleCustomMCPCall(body, typed)
	case []any:
		if !batchContainsCustomMCPProxyCall(typed) {
			return customMCPRequestFilterResult{body: body}
		}
		return customMCPRequestFilterResult{
			handled:       true,
			localResponse: customMCPBatchErrorResponses(typed),
		}
	default:
		return customMCPRequestFilterResult{body: body}
	}
}

func filterSingleCustomMCPCall(original []byte, request map[string]any) customMCPRequestFilterResult {
	namespace, operation, arguments, ok := customMCPProxyToolCall(request)
	if !ok {
		return customMCPRequestFilterResult{body: original}
	}

	switch operation {
	case "tools":
		options, failure := parseCustomMCPListOptions(namespace, arguments)
		if failure != nil {
			return customMCPRequestFilterResult{
				handled:       true,
				localResponse: customMCPToolErrorResponse(request["id"], *failure),
			}
		}
		request["method"] = "tools/list"
		delete(request, "params")
		rewritten, err := json.Marshal(request)
		if err != nil {
			return customMCPRequestFilterResult{body: original}
		}
		return customMCPRequestFilterResult{body: rewritten, listOptions: &options}
	case "execute":
		toolName, _ := arguments["name"].(string)
		toolName = strings.TrimSpace(toolName)
		if !validCustomMCPToolSegment(toolName) {
			return customMCPRequestFilterResult{
				handled: true,
				localResponse: customMCPToolErrorResponse(request["id"], toolError{
					code:    "invalid_custom_mcp_tool",
					message: "name must be an exact tool name returned by this namespace's tools tool",
				}),
			}
		}
		toolArguments := map[string]any{}
		if rawArguments, exists := arguments["arguments"]; exists {
			var valid bool
			toolArguments, valid = rawArguments.(map[string]any)
			if !valid {
				return customMCPRequestFilterResult{
					handled: true,
					localResponse: customMCPToolErrorResponse(request["id"], toolError{
						code:    "invalid_custom_mcp_arguments",
						message: "arguments must be a JSON object",
					}),
				}
			}
		}
		request["params"] = map[string]any{
			"name":      "mcp-" + namespace + "__" + toolName,
			"arguments": toolArguments,
		}
		rewritten, err := json.Marshal(request)
		if err != nil {
			return customMCPRequestFilterResult{body: original}
		}
		return customMCPRequestFilterResult{body: rewritten}
	default:
		return customMCPRequestFilterResult{body: original}
	}
}

func customMCPProxyToolCall(request map[string]any) (string, string, map[string]any, bool) {
	method, _ := request["method"].(string)
	if method != "tools/call" {
		return "", "", nil, false
	}
	params, ok := request["params"].(map[string]any)
	if !ok {
		return "", "", nil, false
	}
	name, _ := params["name"].(string)
	namespace, operation, ok := splitCustomMCPProxyToolName(name)
	if !ok {
		return "", "", nil, false
	}
	arguments := map[string]any{}
	if rawArguments, exists := params["arguments"]; exists {
		arguments, ok = rawArguments.(map[string]any)
		if !ok {
			arguments = map[string]any{"__invalid_arguments": rawArguments}
		}
	}
	return namespace, operation, arguments, true
}

func splitCustomMCPProxyToolName(name string) (string, string, bool) {
	separator := strings.LastIndex(name, "__")
	if separator <= 0 {
		return "", "", false
	}
	namespace := name[:separator]
	operation := name[separator+2:]
	if (operation != "tools" && operation != "execute") || !validCustomMCPNamespace(namespace) {
		return "", "", false
	}
	return namespace, operation, true
}

func validCustomMCPNamespace(namespace string) bool {
	if namespace == "" || len(namespace) > 64 || strings.HasPrefix(namespace, "mcp-") ||
		namespace == "kb" || namespace == "connector" {
		return false
	}
	for index, char := range namespace {
		if (char >= 'a' && char <= 'z') || (char >= '0' && char <= '9') || (char == '-' && index > 0) {
			continue
		}
		return false
	}
	return !strings.HasSuffix(namespace, "-")
}

func validCustomMCPToolSegment(name string) bool {
	if name == "" || len(name) > 200 || strings.Contains(name, "__") {
		return false
	}
	for _, char := range name {
		if (char >= 'a' && char <= 'z') || (char >= 'A' && char <= 'Z') ||
			(char >= '0' && char <= '9') || char == '_' || char == '-' || char == '.' {
			continue
		}
		return false
	}
	return true
}

func parseCustomMCPListOptions(namespace string, arguments map[string]any) (customMCPListOptions, *toolError) {
	options := customMCPListOptions{
		namespace: namespace,
		limit:     defaultCustomMCPListLimit,
	}
	if _, invalid := arguments["__invalid_arguments"]; invalid {
		return options, &toolError{code: "invalid_custom_mcp_arguments", message: "arguments must be a JSON object"}
	}
	if rawQuery, exists := arguments["query"]; exists {
		query, ok := rawQuery.(string)
		if !ok || len(query) > 200 {
			return options, &toolError{code: "invalid_custom_mcp_query", message: "query must be a string of at most 200 characters"}
		}
		options.query = strings.TrimSpace(query)
	}
	if rawOffset, exists := arguments["offset"]; exists {
		offset, ok := nonNegativeJSONInteger(rawOffset)
		if !ok {
			return options, &toolError{code: "invalid_custom_mcp_offset", message: "offset must be a non-negative integer"}
		}
		options.offset = offset
	}
	if rawLimit, exists := arguments["limit"]; exists {
		limit, ok := nonNegativeJSONInteger(rawLimit)
		if !ok || limit < 1 || limit > maxCustomMCPListLimit {
			return options, &toolError{code: "invalid_custom_mcp_limit", message: "limit must be an integer between 1 and 100"}
		}
		options.limit = limit
	}
	return options, nil
}

func nonNegativeJSONInteger(value any) (int, bool) {
	switch typed := value.(type) {
	case json.Number:
		integer, err := strconv.Atoi(typed.String())
		return integer, err == nil && integer >= 0
	case float64:
		integer := int(typed)
		return integer, typed == float64(integer) && integer >= 0
	case int:
		return typed, typed >= 0
	default:
		return 0, false
	}
}

func parseInternalCustomMCPToolName(name string) (string, string, bool) {
	if !strings.HasPrefix(name, "mcp-") || strings.HasPrefix(name, "mcp-rag__") || strings.HasPrefix(name, "mcp-open-connector__") {
		return "", "", false
	}
	separator := strings.Index(name, "__")
	if separator <= len("mcp-") || separator+2 >= len(name) {
		return "", "", false
	}
	namespace := name[len("mcp-"):separator]
	toolName := name[separator+2:]
	if !validCustomMCPNamespace(namespace) || !validCustomMCPToolSegment(toolName) {
		return "", "", false
	}
	return namespace, toolName, true
}

func customMCPProxyToolDefinitions(
	namespace string,
	metadata customMCPMetadata,
	tools []map[string]any,
) []any {
	displayName := metadata.displayName
	if displayName == "" {
		displayName = namespace
	}
	purpose := customMCPPurposeSummary(tools)
	configuredService := "configured MCP service " + strconv.Quote(displayName) + " (namespace " + namespace + ")"
	toolCount := strconv.Itoa(len(tools))
	return []any{
		map[string]any{
			"name":        namespace + "__tools",
			"title":       displayName + " Tools",
			"description": "Discover the " + toolCount + " tools currently allowed from " + configuredService + purpose + ". Use query and pagination to keep results small, then call " + namespace + "__execute with an exact returned tool name.",
			"inputSchema": map[string]any{
				"type": "object",
				"properties": map[string]any{
					"query": map[string]any{
						"type":        "string",
						"description": "Optional case-insensitive search across tool name, title, and description.",
					},
					"offset": map[string]any{
						"type":        "integer",
						"minimum":     0,
						"default":     0,
						"description": "Zero-based result offset.",
					},
					"limit": map[string]any{
						"type":        "integer",
						"minimum":     1,
						"maximum":     maxCustomMCPListLimit,
						"default":     defaultCustomMCPListLimit,
						"description": "Maximum tools to return.",
					},
				},
				"additionalProperties": false,
			},
		},
		map[string]any{
			"name":        namespace + "__execute",
			"title":       displayName + " Execute",
			"description": "Execute one of the " + toolCount + " tools currently allowed from " + configuredService + purpose + ". Call " + namespace + "__tools first and pass an exact returned tool name and its arguments.",
			"inputSchema": map[string]any{
				"type": "object",
				"properties": map[string]any{
					"name": map[string]any{
						"type":        "string",
						"description": "Exact tool name returned by " + namespace + "__tools.",
					},
					"arguments": map[string]any{
						"type":        "object",
						"description": "Arguments matching the selected tool's inputSchema.",
						"default":     map[string]any{},
					},
				},
				"required":             []string{"name"},
				"additionalProperties": false,
			},
		},
	}
}

func customMCPPurposeSummary(tools []map[string]any) string {
	summaries := make([]string, 0, 3)
	seen := make(map[string]struct{})
	for _, tool := range tools {
		name := stringValue(tool["name"])
		_, publicName, valid := parseInternalCustomMCPToolName(name)
		if !valid {
			continue
		}
		summary := firstNonEmptyString(stringValue(tool["description"]), stringValue(tool["title"]), publicName)
		summary = compactCustomMCPText(summary, 120)
		if summary == "" {
			continue
		}
		if _, exists := seen[summary]; exists {
			continue
		}
		seen[summary] = struct{}{}
		summaries = append(summaries, summary)
		if len(summaries) == 3 {
			break
		}
	}
	if len(summaries) == 0 {
		return ""
	}
	return ". Representative capabilities: " + strings.Join(summaries, "; ")
}

func firstNonEmptyString(values ...string) string {
	for _, value := range values {
		if strings.TrimSpace(value) != "" {
			return value
		}
	}
	return ""
}

func compactCustomMCPText(value string, limit int) string {
	value = strings.Join(strings.Fields(value), " ")
	runes := []rune(value)
	if len(runes) <= limit {
		return value
	}
	return strings.TrimSpace(string(runes[:limit-1])) + "…"
}

func rewriteCustomMCPListResponse(response *http.Response, options customMCPListOptions) error {
	if response == nil || response.Body == nil {
		return nil
	}
	rewriter := func(body []byte) ([]byte, bool) {
		return rewriteCustomMCPListResponseJSON(body, options)
	}
	contentType := strings.ToLower(response.Header.Get("Content-Type"))
	if strings.Contains(contentType, "text/event-stream") {
		response.Body = newMCPJSONRewriteSSEBody(response.Body, rewriter)
		response.ContentLength = -1
		response.Header.Del("Content-Length")
		return nil
	}

	body, err := io.ReadAll(io.LimitReader(response.Body, maxMCPToolListResponseBody+1))
	if err != nil {
		return fmt.Errorf("read custom MCP tools/list response: %w", err)
	}
	if len(body) > maxMCPToolListResponseBody {
		return fmt.Errorf("custom MCP tools/list response exceeds %d bytes", maxMCPToolListResponseBody)
	}
	_ = response.Body.Close()
	if rewritten, changed := rewriter(body); changed {
		body = rewritten
	}
	response.Body = io.NopCloser(bytes.NewReader(body))
	response.ContentLength = int64(len(body))
	response.Header.Del("Content-Encoding")
	response.Header.Set("Content-Length", strconv.Itoa(len(body)))
	return nil
}

func rewriteCustomMCPListResponseJSON(body []byte, options customMCPListOptions) ([]byte, bool) {
	decoder := json.NewDecoder(bytes.NewReader(body))
	decoder.UseNumber()
	var payload any
	if err := decoder.Decode(&payload); err != nil {
		return body, false
	}
	response, ok := payload.(map[string]any)
	if !ok || response["error"] != nil {
		return body, false
	}
	result, ok := response["result"].(map[string]any)
	if !ok {
		return body, false
	}
	tools, ok := result["tools"].([]any)
	if !ok {
		return body, false
	}

	query := strings.ToLower(options.query)
	listed := make([]map[string]any, 0)
	for _, item := range tools {
		tool, ok := item.(map[string]any)
		if !ok {
			continue
		}
		internalName, _ := tool["name"].(string)
		namespace, toolName, custom := parseInternalCustomMCPToolName(internalName)
		if !custom || namespace != options.namespace {
			continue
		}
		if query != "" {
			haystack := strings.ToLower(toolName + " " + stringValue(tool["title"]) + " " + stringValue(tool["description"]))
			if !strings.Contains(haystack, query) {
				continue
			}
		}
		publicTool := make(map[string]any, len(tool))
		for key, value := range tool {
			publicTool[key] = value
		}
		publicTool["name"] = toolName
		listed = append(listed, publicTool)
	}
	sort.Slice(listed, func(i, j int) bool {
		return stringValue(listed[i]["name"]) < stringValue(listed[j]["name"])
	})

	total := len(listed)
	start := options.offset
	if start > total {
		start = total
	}
	end := start + options.limit
	if end > total {
		end = total
	}
	page := listed[start:end]
	pagination := map[string]any{
		"offset": start,
		"limit":  options.limit,
		"total":  total,
	}
	if end < total {
		pagination["nextOffset"] = end
	}
	payloadResult := map[string]any{
		"ok":         true,
		"namespace":  options.namespace,
		"tools":      page,
		"pagination": pagination,
	}
	response["result"] = customMCPToolResult(payloadResult, false)
	rewritten, err := json.Marshal(response)
	if err != nil {
		return body, false
	}
	return rewritten, true
}

func stringValue(value any) string {
	text, _ := value.(string)
	return text
}

func customMCPToolErrorResponse(id any, failure toolError) map[string]any {
	payload := map[string]any{
		"ok": false,
		"error": map[string]any{
			"code":    failure.code,
			"message": failure.message,
		},
	}
	return map[string]any{
		"jsonrpc": "2.0",
		"id":      id,
		"result":  customMCPToolResult(payload, true),
	}
}

func customMCPToolResult(payload map[string]any, isError bool) map[string]any {
	pretty, err := json.MarshalIndent(payload, "", "  ")
	if err != nil {
		pretty = []byte(`{"ok":false,"error":{"code":"internal_error","message":"Could not encode custom MCP response"}}`)
		isError = true
	}
	result := map[string]any{
		"content":           []map[string]any{{"type": "text", "text": string(pretty)}},
		"structuredContent": payload,
	}
	if isError {
		result["isError"] = true
	}
	return result
}

func batchContainsCustomMCPProxyCall(batch []any) bool {
	for _, item := range batch {
		request, ok := item.(map[string]any)
		if !ok {
			continue
		}
		if _, _, _, custom := customMCPProxyToolCall(request); custom {
			return true
		}
	}
	return false
}

func customMCPBatchErrorResponses(batch []any) []any {
	responses := make([]any, 0, len(batch))
	for _, item := range batch {
		request, ok := item.(map[string]any)
		if !ok {
			continue
		}
		if _, hasID := request["id"]; !hasID {
			continue
		}
		responses = append(responses, map[string]any{
			"jsonrpc": "2.0",
			"id":      request["id"],
			"error": map[string]any{
				"code":    -32600,
				"message": "Batched custom MCP proxy calls are not supported",
			},
		})
	}
	if len(responses) == 0 {
		return []any{map[string]any{
			"jsonrpc": "2.0",
			"id":      nil,
			"error": map[string]any{
				"code":    -32600,
				"message": "Batched custom MCP proxy calls are not supported",
			},
		}}
	}
	return responses
}
