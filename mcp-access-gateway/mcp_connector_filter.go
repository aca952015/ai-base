package main

import (
	"bytes"
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"strings"
)

const maxMCPRequestBody = 2 << 20

var protectedOpenConnectorTools = map[string]struct{}{
	"execute_action":   {},
	"get_action_guide": {},
	"list_connections": {},
}

var hardDeniedConnectorActions = map[string]struct{}{
	"wecom_bot.call_tool":                {},
	"wecom_bot.get_userlist":             {},
	"wecom_bot.send_text_message":        {},
	"wecom_bot.send_markdown_message":    {},
	"wecom_bot.send_markdown_v2_message": {},
	"wecom_bot.send_image_message":       {},
	"wecom_bot.send_news_message":        {},
}

type mcpRequestFilterResult struct {
	body          []byte
	localResponse any
	handled       bool
}

func (g *mcpGateway) filterConnectorRequest(
	ctx context.Context,
	body []byte,
	caller identity,
) mcpRequestFilterResult {
	decoder := json.NewDecoder(bytes.NewReader(body))
	decoder.UseNumber()

	var payload any
	if err := decoder.Decode(&payload); err != nil {
		return mcpRequestFilterResult{body: body}
	}

	switch typed := payload.(type) {
	case map[string]any:
		return g.filterSingleConnectorCall(ctx, body, typed, caller)
	case []any:
		if !batchContainsProtectedConnectorCall(typed) {
			return mcpRequestFilterResult{body: body}
		}
		recordProtectedBatchDecisions(ctx, typed, caller)
		return mcpRequestFilterResult{
			handled:       true,
			localResponse: protectedBatchErrorResponses(typed),
		}
	default:
		return mcpRequestFilterResult{body: body}
	}
}

func (g *mcpGateway) filterSingleConnectorCall(
	ctx context.Context,
	original []byte,
	request map[string]any,
	caller identity,
) mcpRequestFilterResult {
	ctx = messageContext(ctx, request["id"])
	tool, arguments, protected := protectedConnectorToolCall(request)
	if !protected {
		return mcpRequestFilterResult{body: original}
	}

	if tool == "list_connections" {
		bindings, err := g.resolver.list(ctx, caller)
		if err != nil {
			toolErr := resolverToolError(err)
			recordConnectorDecision(ctx, caller, "__other__", "", tool, "__other__", "deny", toolErr.code)
			return mcpRequestFilterResult{
				handled:       true,
				localResponse: connectorToolErrorResponse(request["id"], toolErr),
			}
		}
		if service, _ := arguments["service"].(string); strings.TrimSpace(service) != "" {
			filtered := bindings[:0]
			for _, binding := range bindings {
				if binding.Service == strings.TrimSpace(service) {
					filtered = append(filtered, binding)
				}
			}
			bindings = filtered
		}
		return mcpRequestFilterResult{
			handled:       true,
			localResponse: connectorListResponse(request["id"], bindings),
		}
	}

	actionID, _ := arguments["actionId"].(string)
	service, ok := serviceFromActionID(actionID)
	if !ok {
		recordConnectorDecision(ctx, caller, "__other__", "", tool, "__other__", "deny", "invalid_action_id")
		return mcpRequestFilterResult{
			handled: true,
			localResponse: connectorToolErrorResponse(
				request["id"],
				toolError{
					code:    "invalid_action_id",
					message: "actionId must contain a provider service prefix, for example feishu.list_records",
				},
			),
		}
	}
	if _, denied := hardDeniedConnectorActions[strings.TrimSpace(actionID)]; denied {
		recordConnectorDecision(ctx, caller, service, "", tool, actionID, "deny", "system_hard_deny")
		return mcpRequestFilterResult{
			handled: true,
			localResponse: connectorToolErrorResponse(
				request["id"],
				toolError{
					code:    "action_not_authorized",
					message: "This Action is blocked by the AI Base system security policy",
				},
			),
		}
	}

	requestedConnectionName, _ := arguments["connectionName"].(string)
	requestedConnectionName = strings.TrimSpace(requestedConnectionName)
	if strings.EqualFold(requestedConnectionName, "default") {
		requestedConnectionName = ""
	}
	binding, err := g.resolver.resolve(
		ctx,
		caller,
		service,
		requestedConnectionName,
		strings.TrimSpace(actionID),
	)
	if err != nil {
		recordConnectorDecision(ctx, caller, service, "", tool, actionID, "deny", resolverToolError(err).code)
		return mcpRequestFilterResult{
			handled:       true,
			localResponse: connectorToolErrorResponse(request["id"], resolverToolError(err)),
		}
	}
	if binding.AccessMode == "controlled_shared" {
		if !binding.ActionRestricted || !containsString(binding.AllowedActionIDs, strings.TrimSpace(actionID)) {
			recordConnectorDecision(ctx, caller, service, "", tool, actionID, "deny", "action_not_authorized")
			return mcpRequestFilterResult{
				handled: true,
				localResponse: connectorToolErrorResponse(
					request["id"],
					toolError{
						code:    "action_not_authorized",
						message: "The authenticated employee is not authorized to execute this Connector Action",
					},
				),
			}
		}
	}
	authorizedService := strings.TrimSpace(binding.Service)
	if authorizedService == "" {
		authorizedService = service
	}
	recordConnectorDecision(ctx, caller, authorizedService, binding.ConnectionName, tool, actionID, "allow", binding.AccessMode)

	// The authenticated employee-to-connector mapping is authoritative. Public
	// no-auth providers intentionally use their virtual default connection;
	// credential-backed providers must always receive the server-selected alias.
	if binding.Public {
		delete(arguments, "connectionName")
	} else {
		arguments["connectionName"] = binding.ConnectionName
	}
	updated, err := json.Marshal(request)
	if err != nil {
		return mcpRequestFilterResult{
			handled: true,
			localResponse: connectorToolErrorResponse(
				request["id"],
				toolError{code: "invalid_request", message: "Unable to secure the connector request"},
			),
		}
	}
	return mcpRequestFilterResult{body: updated}
}

func recordProtectedBatchDecisions(ctx context.Context, batch []any, caller identity) {
	for _, item := range batch {
		request, ok := item.(map[string]any)
		if !ok {
			continue
		}
		tool, arguments, protected := protectedConnectorToolCall(request)
		if !protected {
			continue
		}
		actionID, _ := arguments["actionId"].(string)
		service, valid := serviceFromActionID(actionID)
		normalizedAction := strings.TrimSpace(actionID)
		if !valid {
			service = "__other__"
			normalizedAction = "__other__"
		}
		recordConnectorDecision(
			messageContext(ctx, request["id"]),
			caller,
			service,
			"",
			tool,
			normalizedAction,
			"deny",
			"protected_batch_not_supported",
		)
	}
}

func containsString(values []string, expected string) bool {
	for _, value := range values {
		if value == expected {
			return true
		}
	}
	return false
}

func protectedConnectorToolCall(request map[string]any) (string, map[string]any, bool) {
	method, _ := request["method"].(string)
	if method != "tools/call" {
		return "", nil, false
	}

	params, ok := request["params"].(map[string]any)
	if !ok {
		return "", nil, false
	}
	name, _ := params["name"].(string)
	tool := normalizedOpenConnectorTool(name)
	if tool == "" {
		return "", nil, false
	}

	arguments, ok := params["arguments"].(map[string]any)
	if !ok {
		arguments = make(map[string]any)
		params["arguments"] = arguments
	}
	return tool, arguments, true
}

func normalizedOpenConnectorTool(name string) string {
	name = strings.TrimSpace(name)
	if _, ok := protectedOpenConnectorTools[name]; ok {
		return name
	}
	for tool := range protectedOpenConnectorTools {
		if strings.HasSuffix(name, "__"+tool) && len(name) > len(tool)+2 {
			return tool
		}
	}
	return ""
}

func serviceFromActionID(actionID string) (string, bool) {
	actionID = strings.TrimSpace(actionID)
	service, action, found := strings.Cut(actionID, ".")
	service = strings.TrimSpace(service)
	action = strings.TrimSpace(action)
	if !found || service == "" || action == "" {
		return "", false
	}
	for _, character := range service {
		if (character < 'a' || character > 'z') &&
			(character < '0' || character > '9') &&
			character != '_' &&
			character != '-' {
			return "", false
		}
	}
	return service, true
}

func batchContainsProtectedConnectorCall(batch []any) bool {
	for _, item := range batch {
		request, ok := item.(map[string]any)
		if !ok {
			continue
		}
		if _, _, protected := protectedConnectorToolCall(request); protected {
			return true
		}
	}
	return false
}

func protectedBatchErrorResponses(batch []any) []any {
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
				"message": "Batched OpenConnector tool calls are not supported by the identity gateway",
			},
		})
	}
	if len(responses) == 0 {
		return []any{
			map[string]any{
				"jsonrpc": "2.0",
				"id":      nil,
				"error": map[string]any{
					"code":    -32600,
					"message": "Batched OpenConnector tool calls are not supported by the identity gateway",
				},
			},
		}
	}
	return responses
}

type toolError struct {
	code        string
	message     string
	remediation map[string]any
}

func resolverToolError(err error) toolError {
	switch {
	case errors.Is(err, errConnectorActionNotAuthorized):
		return toolError{
			code:    "action_not_authorized",
			message: "The authenticated employee is not authorized to execute this Connector Action",
		}
	case errors.Is(err, errConnectorSelectionRequired):
		return toolError{
			code:    "connector_selection_required",
			message: "More than one authorized Connector is available. Call list_connections and provide an authorized connectionName.",
		}
	case errors.Is(err, errConnectorNotAuthorized):
		return toolError{
			code:    "connector_not_authorized",
			message: "The authenticated employee is not authorized to use the requested Connector",
		}
	case errors.Is(err, errConnectorBindingNotFound):
		return toolError{
			code:    "connector_authorization_required",
			message: "No authorized Connector is available for this employee and service. Bind a personal account or ask an administrator to grant a controlled shared Connector, then retry. Do not request credentials.",
			remediation: map[string]any{
				"action": "open_connector_access",
				"path":   "/connectors",
				"label":  "AI Base Connector 授权",
			},
		}
	case errors.Is(err, errInvalidConnectorBinding):
		return toolError{
			code:    "connector_binding_invalid",
			message: "The employee connector binding is invalid",
		}
	default:
		return toolError{
			code:    "connector_binding_resolver_unavailable",
			message: "Employee connector authorization is temporarily unavailable",
		}
	}
}

func connectorListResponse(id any, bindings []connectorBinding) map[string]any {
	connections := make([]map[string]any, 0, len(bindings))
	for _, binding := range bindings {
		connection := map[string]any{
			"id":             binding.Service + ":" + binding.ConnectionName,
			"service":        binding.Service,
			"connectionName": binding.ConnectionName,
			"default":        binding.Public,
		}
		if binding.Public {
			connection["public"] = true
		}
		if binding.AuthType != "" {
			connection["authType"] = binding.AuthType
		}
		if binding.AccessMode != "" {
			connection["accessMode"] = binding.AccessMode
		}
		if binding.ActionRestricted {
			connection["allowedActionIds"] = binding.AllowedActionIDs
		}
		profile := binding.Profile
		if profile == nil && binding.DisplayName != "" {
			profile = map[string]any{"displayName": binding.DisplayName}
		}
		if profile != nil {
			connection["profile"] = profile
		}
		connections = append(connections, connection)
	}
	return connectorToolResponse(id, map[string]any{
		"ok":   true,
		"data": connections,
	}, false)
}

func connectorToolErrorResponse(id any, failure toolError) map[string]any {
	errorPayload := map[string]any{
		"code":    failure.code,
		"message": failure.message,
	}
	if failure.remediation != nil {
		errorPayload["remediation"] = failure.remediation
	}
	return connectorToolResponse(id, map[string]any{
		"ok":    false,
		"error": errorPayload,
	}, true)
}

func connectorToolResponse(id any, payload map[string]any, isError bool) map[string]any {
	pretty, err := json.MarshalIndent(payload, "", "  ")
	if err != nil {
		pretty = []byte(fmt.Sprintf(`{"ok":false,"error":{"code":"internal_error","message":%q}}`, err.Error()))
		isError = true
	}
	result := map[string]any{
		"content": []map[string]any{
			{
				"type": "text",
				"text": string(pretty),
			},
		},
		"structuredContent": payload,
	}
	if isError {
		result["isError"] = true
	}
	return map[string]any{
		"jsonrpc": "2.0",
		"id":      id,
		"result":  result,
	}
}
