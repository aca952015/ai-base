package main

import (
	"context"
	"encoding/hex"
	"encoding/json"
	"io"
	"net/http"
	"net/http/httptest"
	"strconv"
	"strings"
	"testing"

	"go.opentelemetry.io/otel/codes"
	"go.opentelemetry.io/otel/propagation"
	sdktrace "go.opentelemetry.io/otel/sdk/trace"
	"go.opentelemetry.io/otel/sdk/trace/tracetest"
)

func TestPrincipalFingerprintUsesLengthPrefixedVersionedHMAC(t *testing.T) {
	key, err := hex.DecodeString("000102030405060708090a0b0c0d0e0f101112131415161718191a1b1c1d1e1f")
	if err != nil {
		t.Fatal(err)
	}
	observer := &gatewayObservability{
		hmacKey:    key,
		keyVersion: "2026-08-a",
	}
	first, version, ok := observer.principalFingerprint(identity{issuer: "ab", subject: "c"})
	if !ok || version != "2026-08-a" {
		t.Fatalf("expected configured fingerprint, got %q %q %v", first, version, ok)
	}
	if first != "7402309d2d8c4bf12a1e78815b51caf5" {
		t.Fatalf("length-prefixed HMAC fixture changed: %s", first)
	}
	second, _, _ := observer.principalFingerprint(identity{issuer: "a", subject: "bc"})
	if second != "43f992c377fe8dbc03afbac4fbf95306" {
		t.Fatalf("second length-prefixed HMAC fixture changed: %s", second)
	}
	if first == second {
		t.Fatal("length-prefix boundary collision was not prevented")
	}
	if len(first) != 32 {
		t.Fatalf("fingerprint must be a 16-byte hex digest, got %q", first)
	}

	if fingerprint, keyVersion, configured := (&gatewayObservability{}).principalFingerprint(identity{
		issuer: "raw-issuer", subject: "raw-subject",
	}); configured || fingerprint != "" || keyVersion != "" {
		t.Fatalf("missing HMAC configuration must omit identity, got %q %q", fingerprint, keyVersion)
	}
}

func TestGatewayResourceKeepsCanonicalServiceNameWithoutSchemaConflict(t *testing.T) {
	res := gatewayResource()
	for _, item := range res.Attributes() {
		if item.Key == "service.name" {
			if got := item.Value.AsString(); got != "ai-base-mcp-access-gateway" {
				t.Fatalf("unexpected service.name: %q", got)
			}
			return
		}
	}
	t.Fatal("gateway resource is missing service.name")
}

func TestMCPSpanMetricsDimensionsExcludeTraceDetail(t *testing.T) {
	expected := []string{
		"traffic.origin", "mcp.method.name", "mcp.server.name", "mcp.tool.name",
		"mcp.action.name", "mcp.decision", "mcp.reason", "mcp.result", "error.type",
	}
	if len(mcpSpanMetricsDimensionAttributes) != len(expected) {
		t.Fatalf("unexpected SpanMetrics dimensions: %#v", mcpSpanMetricsDimensionAttributes)
	}
	for index, name := range expected {
		if mcpSpanMetricsDimensionAttributes[index] != name {
			t.Fatalf("unexpected SpanMetrics dimension at %d: %q", index, mcpSpanMetricsDimensionAttributes[index])
		}
	}
	for _, forbidden := range []string{
		"rpc.method", "mcp.server.namespace", "mcp.tool.detail", "mcp.action", "mcp.result.detail",
		"mcp.principal.fingerprint", "mcp.oauth.client_id", "mcp.connection.name",
	} {
		for _, dimension := range mcpSpanMetricsDimensionAttributes {
			if dimension == forbidden {
				t.Fatalf("trace-only attribute %q entered SpanMetrics dimensions", forbidden)
			}
		}
	}
}

func TestPublicMCPStripsExternalCarriersAndRecordsSafeError(t *testing.T) {
	const sentinel = "SENTINEL_TOOL_BODY_MUST_NOT_ENTER_TELEMETRY"
	var upstreamHeaders http.Header
	var upstreamPayload map[string]any
	upstream := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		upstreamHeaders = r.Header.Clone()
		if err := json.NewDecoder(r.Body).Decode(&upstreamPayload); err != nil {
			t.Errorf("decode upstream request: %v", err)
		}
		writeJSON(w, http.StatusOK, map[string]any{
			"jsonrpc": "2.0",
			"id":      7,
			"error": map[string]any{
				"code":    -32603,
				"message": sentinel,
				"data":    map[string]any{"secret": sentinel},
			},
		})
	}))
	defer upstream.Close()

	cfg := testConfig(t, upstream.URL+"/mcp")
	gateway, recorder, shutdown := newRecordedGateway(t, cfg, fakeVerifier{identities: map[string]identity{
		"alice-token": {issuer: "https://id.example", subject: "alice", clientID: "workbuddy"},
	}}, &fakeConnectorResolver{})
	defer shutdown()
	server := httptest.NewServer(gateway.routes())
	defer server.Close()

	messageMeta := map[string]any{}
	for _, name := range externalTraceHeaders {
		messageMeta[name] = "forged-carrier"
	}
	messageMeta["traceparent"] = "00-11111111111111111111111111111111-2222222222222222-00"
	payload := map[string]any{
		"jsonrpc": "2.0", "id": 7, "method": "tools/list",
		"params": map[string]any{
			"_meta": messageMeta,
			"arguments": map[string]any{
				"secret": sentinel,
				"_meta":  map[string]any{"uber-trace-id": "forged", "sampled": 0},
			},
		},
	}
	encodedPayload, err := json.Marshal(payload)
	if err != nil {
		t.Fatal(err)
	}
	request, err := http.NewRequest(http.MethodPost, server.URL+"/mcp", strings.NewReader(string(encodedPayload)))
	if err != nil {
		t.Fatal(err)
	}
	request.Header.Set("Authorization", "Bearer alice-token")
	for _, name := range externalTraceHeaders {
		if strings.EqualFold(name, trafficOriginHeader) {
			request.Header.Set(name, "attacker-controlled")
		} else {
			request.Header.Set(name, "forged-carrier")
		}
	}
	request.Header.Set("traceparent", "00-11111111111111111111111111111111-2222222222222222-00")

	response, err := http.DefaultClient.Do(request)
	if err != nil {
		t.Fatal(err)
	}
	responseBody, err := io.ReadAll(response.Body)
	_ = response.Body.Close()
	if err != nil || !strings.Contains(string(responseBody), sentinel) {
		t.Fatalf("business response must pass through unchanged: %v %s", err, responseBody)
	}

	if got := upstreamHeaders.Get(trafficOriginHeader); got != publicMCPGatewayOrigin {
		t.Fatalf("gateway origin was not sealed: %q", got)
	}
	for _, name := range externalTraceHeaders {
		lower := strings.ToLower(name)
		if lower == "traceparent" || lower == strings.ToLower(trafficOriginHeader) {
			continue
		}
		if got := upstreamHeaders.Get(name); got != "" {
			t.Fatalf("external carrier %s leaked upstream: %q", name, got)
		}
	}
	if traceparent := upstreamHeaders.Get("traceparent"); traceparent == "" || strings.Contains(traceparent, "11111111111111111111111111111111") {
		t.Fatalf("expected server-owned outbound trace context, got %q", traceparent)
	}

	params := upstreamPayload["params"].(map[string]any)
	meta := params["_meta"].(map[string]any)
	if traceparent, _ := meta["traceparent"].(string); traceparent == "" || strings.Contains(traceparent, "11111111111111111111111111111111") {
		t.Fatalf("message context was not replaced: %#v", meta)
	}
	for _, name := range externalTraceHeaders {
		if strings.EqualFold(name, "traceparent") {
			continue
		}
		if value, exists := meta[name]; exists {
			t.Fatalf("message carrier %s was not cleared: %#v", name, value)
		}
	}
	arguments := params["arguments"].(map[string]any)
	if arguments["secret"] != sentinel {
		t.Fatalf("business arguments changed: %#v", arguments)
	}
	nestedMeta := arguments["_meta"].(map[string]any)
	if len(nestedMeta) != 0 {
		t.Fatalf("nested trace metadata was not cleared: %#v", nestedMeta)
	}

	spans := recorder.Ended()
	message := findSpan(t, spans, "mcp.server.message")
	if message.Parent().TraceID().String() == "11111111111111111111111111111111" || message.SpanContext().TraceID().String() == "11111111111111111111111111111111" {
		t.Fatal("external parent influenced the platform trace")
	}
	attributes := spanAttributes(message)
	if attributes["mcp.result"] != "error" || attributes["rpc.jsonrpc.error_code"] != int64(-32603) || attributes["error.type"] != "protocol_error" {
		t.Fatalf("unexpected safe error classification: %#v", attributes)
	}
	if message.Status().Code != codes.Error {
		t.Fatalf("protocol error must have error status: %#v", message.Status())
	}
	assertNoSpanContains(t, spans, sentinel, "alice", "raw-subject")
}

func TestParseableUnauthenticatedMessageHasDeterministicResult(t *testing.T) {
	cfg := testConfig(t, "http://127.0.0.1:1/mcp")
	cfg.observabilityHMACKey = []byte("test-observability-hmac-key-32byt")
	cfg.observabilityKeyVersion = "v-test"
	gateway, recorder, shutdown := newRecordedGateway(t, cfg, fakeVerifier{}, &fakeConnectorResolver{})
	defer shutdown()
	server := httptest.NewServer(gateway.routes())
	defer server.Close()

	request, err := http.NewRequest(http.MethodPost, server.URL+"/mcp", strings.NewReader(
		`{"jsonrpc":"2.0","id":"unauthorized","method":"tools/list","params":{"_meta":{"traceparent":"forged"}}}`,
	))
	if err != nil {
		t.Fatal(err)
	}
	response, err := http.DefaultClient.Do(request)
	if err != nil {
		t.Fatal(err)
	}
	_, _ = io.Copy(io.Discard, response.Body)
	_ = response.Body.Close()
	if response.StatusCode != http.StatusUnauthorized {
		t.Fatalf("expected authentication rejection, got %d", response.StatusCode)
	}

	message := findSpan(t, recorder.Ended(), "mcp.server.message")
	if spanAttributes(message)["mcp.result"] != "authentication_failed" {
		t.Fatalf("authentication failure was not classified: %#v", spanAttributes(message))
	}
	if message.Status().Code != codes.Unset {
		t.Fatalf("authentication rejection must not masquerade as upstream error: %#v", message.Status())
	}
	for _, forbidden := range []string{"mcp.principal.fingerprint", "mcp.principal.key_version", "mcp.oauth.client_id"} {
		if _, exists := spanAttributes(message)[forbidden]; exists {
			t.Fatalf("authentication failure leaked %s: %#v", forbidden, spanAttributes(message))
		}
	}
}

func TestAuthenticatedCallerBindsToAllOrdinaryMessages(t *testing.T) {
	methods := []string{"initialize", "ping", "tools/list", "resources/list", "prompts/list"}
	upstream := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		var requests []map[string]any
		if err := json.NewDecoder(r.Body).Decode(&requests); err != nil {
			t.Fatal(err)
		}
		responses := make([]any, 0, len(requests))
		for _, request := range requests {
			responses = append(responses, map[string]any{"jsonrpc": "2.0", "id": request["id"], "result": map[string]any{}})
		}
		writeJSON(w, http.StatusOK, responses)
	}))
	defer upstream.Close()

	caller := identity{issuer: "https://issuer.example", subject: "ordinary-employee", clientID: "workbuddy"}
	cfg := testConfig(t, upstream.URL+"/mcp")
	cfg.observabilityHMACKey = []byte("test-observability-hmac-key-32byt")
	cfg.observabilityKeyVersion = "v-test"
	gateway, recorder, shutdown := newRecordedGateway(t, cfg, fakeVerifier{identities: map[string]identity{"token": caller}}, &fakeConnectorResolver{})
	defer shutdown()
	server := httptest.NewServer(gateway.routes())
	defer server.Close()

	payload := make([]any, 0, len(methods))
	for index, method := range methods {
		payload = append(payload, map[string]any{"jsonrpc": "2.0", "id": index, "method": method})
	}
	response := authenticatedMCPRequest(t, server.URL, "token", payload)
	_, _ = io.Copy(io.Discard, response.Body)
	_ = response.Body.Close()

	expectedFingerprint, _, ok := gateway.observe.principalFingerprint(caller)
	if !ok {
		t.Fatal("test principal fingerprint was not configured")
	}
	seen := 0
	for _, span := range recorder.Ended() {
		if span.Name() != "mcp.server.message" {
			continue
		}
		attributes := spanAttributes(span)
		if attributes["mcp.principal.fingerprint"] != expectedFingerprint ||
			attributes["mcp.principal.key_version"] != "v-test" ||
			attributes["mcp.oauth.client_id"] != "workbuddy" {
			t.Fatalf("ordinary message missing authenticated summary: %#v", attributes)
		}
		seen++
	}
	if seen != len(methods) {
		t.Fatalf("expected %d authenticated ordinary spans, got %d", len(methods), seen)
	}
	assertNoSpanContains(t, recorder.Ended(), caller.issuer, caller.subject)
}

func TestOAuthClientSummaryIsLowCardinality(t *testing.T) {
	tests := map[string]string{
		"workbuddy":                              "workbuddy",
		"ai-base-abcdefghijklmnopqrstuvwxyz0123": "ai-base-dcr",
		"another-verified-client":                "other",
		"unsafe client value":                    "",
	}
	for input, expected := range tests {
		if actual := oauthClientSummary(input); actual != expected {
			t.Fatalf("oauthClientSummary(%q) = %q, want %q", input, actual, expected)
		}
	}
}

func TestSessionRejectionKeepsAuthenticatedSummaryWithoutUpstreamErrorStatus(t *testing.T) {
	caller := identity{issuer: "https://issuer.example", subject: "employee", clientID: "workbuddy"}
	cfg := testConfig(t, "http://127.0.0.1:1/mcp")
	cfg.observabilityHMACKey = []byte("test-observability-hmac-key-32byt")
	cfg.observabilityKeyVersion = "v-test"
	gateway, recorder, shutdown := newRecordedGateway(t, cfg, fakeVerifier{identities: map[string]identity{"token": caller}}, &fakeConnectorResolver{})
	defer shutdown()
	server := httptest.NewServer(gateway.routes())
	defer server.Close()

	body := `{"jsonrpc":"2.0","id":1,"method":"ping"}`
	request, err := http.NewRequest(http.MethodPost, server.URL+"/mcp", strings.NewReader(body))
	if err != nil {
		t.Fatal(err)
	}
	request.Header.Set("Authorization", "Bearer token")
	request.Header.Set(sessionHeader, "invalid-sealed-session")
	response, err := http.DefaultClient.Do(request)
	if err != nil {
		t.Fatal(err)
	}
	_, _ = io.Copy(io.Discard, response.Body)
	_ = response.Body.Close()
	if response.StatusCode != http.StatusForbidden {
		t.Fatalf("expected session rejection, got %d", response.StatusCode)
	}

	message := findSpan(t, recorder.Ended(), "mcp.server.message")
	attributes := spanAttributes(message)
	if attributes["mcp.result"] != "session_rejected" || message.Status().Code != codes.Unset {
		t.Fatalf("session rejection masqueraded as upstream error: attrs=%#v status=%#v", attributes, message.Status())
	}
	if attributes["mcp.oauth.client_id"] != "workbuddy" || attributes["mcp.principal.key_version"] != "v-test" {
		t.Fatalf("verified caller summary missing from session rejection: %#v", attributes)
	}
}

func TestUpstreamFailuresHavePreciseErrorResults(t *testing.T) {
	tests := []struct {
		name           string
		upstream       func(t *testing.T) (string, func())
		expectedResult string
		expectedError  string
	}{
		{
			name: "transport unavailable",
			upstream: func(_ *testing.T) (string, func()) {
				return "http://127.0.0.1:1/mcp", func() {}
			},
			expectedResult: "upstream_unavailable",
			expectedError:  "upstream_unavailable",
		},
		{
			name: "upstream HTTP error",
			upstream: func(_ *testing.T) (string, func()) {
				server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, _ *http.Request) {
					writeJSON(w, http.StatusServiceUnavailable, map[string]any{"error": "not observed"})
				}))
				return server.URL + "/mcp", server.Close
			},
			expectedResult: "http_error",
			expectedError:  "upstream_http_error",
		},
	}

	for _, test := range tests {
		t.Run(test.name, func(t *testing.T) {
			upstreamURL, closeUpstream := test.upstream(t)
			defer closeUpstream()
			cfg := testConfig(t, upstreamURL)
			gateway, recorder, shutdown := newRecordedGateway(t, cfg, fakeVerifier{identities: map[string]identity{
				"token": {issuer: "issuer", subject: "subject", clientID: "workbuddy"},
			}}, &fakeConnectorResolver{})
			defer shutdown()
			server := httptest.NewServer(gateway.routes())
			defer server.Close()

			response := authenticatedMCPRequest(t, server.URL, "token", map[string]any{
				"jsonrpc": "2.0", "id": 1, "method": "ping",
			})
			_, _ = io.Copy(io.Discard, response.Body)
			_ = response.Body.Close()
			message := findSpan(t, recorder.Ended(), "mcp.server.message")
			attributes := spanAttributes(message)
			if attributes["mcp.result"] != test.expectedResult || attributes["error.type"] != test.expectedError || message.Status().Code != codes.Error {
				t.Fatalf("upstream error classification mismatch: attrs=%#v status=%#v", attributes, message.Status())
			}
		})
	}
}

func TestMCPMessageResultsCoverAllowDenyNotificationAndUnobserved(t *testing.T) {
	tests := []struct {
		name             string
		payload          map[string]any
		upstreamBody     any
		resolver         *fakeConnectorResolver
		expectedResult   string
		expectedDecision string
	}{
		{
			name:           "allowed response",
			payload:        connectorRequest(1, "feishu.search_bitable_records"),
			upstreamBody:   map[string]any{"jsonrpc": "2.0", "id": 1, "result": map[string]any{}},
			resolver:       &fakeConnectorResolver{binding: connectorBinding{Service: "feishu", ConnectionName: "employee_a", AccessMode: "account_bound"}},
			expectedResult: "success", expectedDecision: "allow",
		},
		{
			name:           "local hard deny",
			payload:        connectorRequest(2, "wecom_bot.call_tool"),
			resolver:       &fakeConnectorResolver{},
			expectedResult: "denied", expectedDecision: "deny",
		},
		{
			name: "local resolver rejection",
			payload: map[string]any{
				"jsonrpc": "2.0", "id": 3, "method": "tools/call",
				"params": map[string]any{"name": "list_connections", "arguments": map[string]any{}},
			},
			resolver:         &fakeConnectorResolver{listErr: errConnectorResolverUnavailable},
			expectedResult:   "denied",
			expectedDecision: "deny",
		},
		{
			name:           "notification",
			payload:        map[string]any{"jsonrpc": "2.0", "method": "notifications/initialized"},
			upstreamBody:   map[string]any{},
			resolver:       &fakeConnectorResolver{},
			expectedResult: "no_response_expected",
		},
		{
			name:           "unmatched response",
			payload:        map[string]any{"jsonrpc": "2.0", "id": "expected", "method": "tools/list"},
			upstreamBody:   map[string]any{"jsonrpc": "2.0", "id": "different", "result": map[string]any{}},
			resolver:       &fakeConnectorResolver{},
			expectedResult: "unobserved",
		},
	}

	for _, test := range tests {
		t.Run(test.name, func(t *testing.T) {
			upstream := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, _ *http.Request) {
				writeJSON(w, http.StatusOK, test.upstreamBody)
			}))
			defer upstream.Close()
			cfg := testConfig(t, upstream.URL+"/mcp")
			cfg.observabilityHMACKey = []byte("test-observability-hmac-key-32byt")
			cfg.observabilityKeyVersion = "v-test"
			gateway, recorder, shutdown := newRecordedGateway(t, cfg, fakeVerifier{identities: map[string]identity{
				"token": {issuer: "https://issuer.example", subject: "employee", clientID: "client"},
			}}, test.resolver)
			defer shutdown()
			server := httptest.NewServer(gateway.routes())
			defer server.Close()

			response := authenticatedMCPRequest(t, server.URL, "token", test.payload)
			_, _ = io.Copy(io.Discard, response.Body)
			_ = response.Body.Close()

			message := findSpan(t, recorder.Ended(), "mcp.server.message")
			attributes := spanAttributes(message)
			if attributes["mcp.result"] != test.expectedResult {
				t.Fatalf("expected %q, got %#v", test.expectedResult, attributes)
			}
			if test.expectedDecision != "" {
				if attributes["mcp.authorization.decision"] != test.expectedDecision {
					t.Fatalf("expected decision %q, got %#v", test.expectedDecision, attributes)
				}
				if attributes["mcp.principal.key_version"] != "v-test" {
					t.Fatalf("expected versioned principal fingerprint: %#v", attributes)
				}
				fingerprint, _ := attributes["mcp.principal.fingerprint"].(string)
				if len(fingerprint) != 32 || strings.Contains(fingerprint, "employee") {
					t.Fatalf("unsafe principal fingerprint: %#v", attributes)
				}
				if test.expectedDecision == "allow" {
					if attributes["mcp.server.name"] != "feishu" ||
						attributes["mcp.tool.name"] != "execute_action" ||
						attributes["mcp.action.name"] != "feishu.search_bitable_records" {
						t.Fatalf("authorized metric targets were not populated: %#v", attributes)
					}
					if attributes["mcp.connection.name"] != "employee_a" {
						t.Fatalf("server-selected connection was not recorded: %#v", attributes)
					}
				} else if message.Status().Code != codes.Unset {
					t.Fatalf("policy denial must not masquerade as upstream error: %#v", message.Status())
				} else if attributes["mcp.server.name"] != "__other__" ||
					attributes["mcp.tool.name"] != "__other__" ||
					attributes["mcp.action.name"] != "__other__" {
					t.Fatalf("denied metric targets must stay bounded: %#v", attributes)
				} else if _, exists := attributes["mcp.connection.name"]; exists {
					t.Fatalf("denied span exposed a connection: %#v", attributes)
				}
			}
		})
	}
}

func TestRandomDeniedTargetsDoNotCreateMetricCardinality(t *testing.T) {
	const sentinel = "SENTINEL_FORGED_ACTION_MUST_NOT_ENTER_TELEMETRY"
	upstream := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, _ *http.Request) {
		t.Fatal("denied requests must not reach upstream")
	}))
	defer upstream.Close()
	resolver := &fakeConnectorResolver{resolveErr: errConnectorBindingNotFound}
	gateway, recorder, shutdown := newRecordedGateway(t, testConfig(t, upstream.URL+"/mcp"), fakeVerifier{identities: map[string]identity{
		"token": {issuer: "issuer", subject: "subject"},
	}}, resolver)
	defer shutdown()
	server := httptest.NewServer(gateway.routes())
	defer server.Close()

	const attempts = 24
	for index := 0; index < attempts; index++ {
		actionID := "random" + strconv.Itoa(index) + ".action" + strconv.Itoa(index)
		if index == 0 {
			actionID = "feishu." + sentinel
		}
		payload := map[string]any{
			"jsonrpc": "2.0", "id": index, "method": "tools/call",
			"params": map[string]any{
				"name": "attacker" + strconv.Itoa(index) + "__execute_action",
				"arguments": map[string]any{
					"actionId":       actionID,
					"connectionName": "forged-request-alias-" + strconv.Itoa(index),
				},
			},
		}
		response := authenticatedMCPRequest(t, server.URL, "token", payload)
		_, _ = io.Copy(io.Discard, response.Body)
		_ = response.Body.Close()
	}

	metricTargets := map[string]struct{}{}
	detailTargets := map[string]struct{}{}
	denied := 0
	for _, span := range recorder.Ended() {
		if span.Name() != "mcp.server.message" {
			continue
		}
		attributes := spanAttributes(span)
		if attributes["mcp.decision"] != "deny" || attributes["mcp.reason"] != "connector_authorization_required" || attributes["mcp.result"] != "denied" {
			t.Fatalf("denied enums were not normalized: %#v", attributes)
		}
		if _, exists := attributes["mcp.connection.name"]; exists {
			t.Fatalf("denied span exposed requested connection alias: %#v", attributes)
		}
		metricTargets[attributes["mcp.server.name"].(string)+"|"+attributes["mcp.tool.name"].(string)+"|"+attributes["mcp.action.name"].(string)] = struct{}{}
		detailTargets[attributes["mcp.action"].(string)] = struct{}{}
		denied++
	}
	if denied != attempts || len(metricTargets) != 1 {
		t.Fatalf("random denials expanded metric targets: denied=%d targets=%#v", denied, metricTargets)
	}
	if _, ok := metricTargets["__other__|__other__|__other__"]; !ok {
		t.Fatalf("unexpected denied metric target: %#v", metricTargets)
	}
	if len(detailTargets) != attempts {
		t.Fatalf("trace detail should retain safe diagnostic targets, got %d", len(detailTargets))
	}
	assertNoSpanContains(t, recorder.Ended(), "forged-request-alias-")
	assertNoSpanContains(t, recorder.Ended(), sentinel)
}

func TestBatchAndSSEResponsesMatchIndividualMessages(t *testing.T) {
	t.Run("batch", func(t *testing.T) {
		upstream := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, _ *http.Request) {
			writeJSON(w, http.StatusOK, []any{
				map[string]any{"jsonrpc": "2.0", "id": "second", "result": map[string]any{}},
				map[string]any{"jsonrpc": "2.0", "id": "first", "result": map[string]any{}},
			})
		}))
		defer upstream.Close()
		gateway, recorder, shutdown := newRecordedGateway(t, testConfig(t, upstream.URL+"/mcp"), fakeVerifier{identities: map[string]identity{
			"token": {issuer: "issuer", subject: "subject"},
		}}, &fakeConnectorResolver{})
		defer shutdown()
		server := httptest.NewServer(gateway.routes())
		defer server.Close()

		response := authenticatedMCPRequest(t, server.URL, "token", []any{
			map[string]any{"jsonrpc": "2.0", "id": "first", "method": "tools/list"},
			map[string]any{"jsonrpc": "2.0", "id": "second", "method": "resources/list"},
		})
		_, _ = io.Copy(io.Discard, response.Body)
		_ = response.Body.Close()

		count := 0
		for _, span := range recorder.Ended() {
			if span.Name() == "mcp.server.message" {
				count++
				if spanAttributes(span)["mcp.result"] != "success" {
					t.Fatalf("batch item was not matched: %#v", spanAttributes(span))
				}
			}
		}
		if count != 2 {
			t.Fatalf("expected one canonical span per batch item, got %d", count)
		}
	})

	t.Run("sse", func(t *testing.T) {
		upstream := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, _ *http.Request) {
			w.Header().Set("Content-Type", "text/event-stream")
			_, _ = io.WriteString(w, "event: message\n")
			_, _ = io.WriteString(w, "data: {\"jsonrpc\":\"2.0\",\"id\":9,\"result\":{}}\n\n")
		}))
		defer upstream.Close()
		gateway, recorder, shutdown := newRecordedGateway(t, testConfig(t, upstream.URL+"/mcp"), fakeVerifier{identities: map[string]identity{
			"token": {issuer: "issuer", subject: "subject"},
		}}, &fakeConnectorResolver{})
		defer shutdown()
		server := httptest.NewServer(gateway.routes())
		defer server.Close()

		response := authenticatedMCPRequest(t, server.URL, "token", map[string]any{
			"jsonrpc": "2.0", "id": 9, "method": "tools/list",
		})
		_, _ = io.Copy(io.Discard, response.Body)
		_ = response.Body.Close()
		message := findSpan(t, recorder.Ended(), "mcp.server.message")
		if spanAttributes(message)["mcp.result"] != "success" {
			t.Fatalf("SSE response was not matched: %#v", spanAttributes(message))
		}
	})
}

func TestMessageObserverLimitFailsOpenWithUnobservedSpans(t *testing.T) {
	recorder := tracetest.NewSpanRecorder()
	provider := sdktrace.NewTracerProvider(
		sdktrace.WithSampler(sdktrace.AlwaysSample()),
		sdktrace.WithSpanProcessor(recorder),
	)
	defer func() { _ = provider.Shutdown(context.Background()) }()
	observer := &gatewayObservability{
		provider:   provider,
		tracer:     provider.Tracer("test"),
		propagator: propagation.NewCompositeTextMapPropagator(propagation.TraceContext{}),
	}
	payload := make([]any, 0, maxTrackedMCPMessages+3)
	for id := 0; id < maxTrackedMCPMessages+3; id++ {
		payload = append(payload, map[string]any{
			"jsonrpc": "2.0", "id": id, "method": "tools/list",
		})
	}
	body, err := json.Marshal(payload)
	if err != nil {
		t.Fatal(err)
	}
	_, tracker := observer.prepareMessages(context.Background(), body, identity{})
	if tracker == nil {
		t.Fatal("expected bounded observer state")
	}
	if len(tracker.ordered) != maxTrackedMCPMessages {
		t.Fatalf("observer state was not bounded: %v records", len(tracker.ordered))
	}
	tracker.finishUnmatched("unobserved")

	messageSpans := 0
	overflowSpans := 0
	for _, span := range recorder.Ended() {
		if span.Name() != "mcp.server.message" {
			continue
		}
		messageSpans++
		attributes := spanAttributes(span)
		if attributes["mcp.observer.overflow"] == true {
			overflowSpans++
			if attributes["mcp.result"] != "unobserved" {
				t.Fatalf("overflow span had unsafe result: %#v", attributes)
			}
		}
	}
	if messageSpans != maxTrackedMCPMessages+3 || overflowSpans != 3 {
		t.Fatalf("expected all messages represented with 3 overflow spans, got %d and %d", messageSpans, overflowSpans)
	}
}

func connectorRequest(id int, action string) map[string]any {
	return map[string]any{
		"jsonrpc": "2.0", "id": id, "method": "tools/call",
		"params": map[string]any{
			"name":      "execute_action",
			"arguments": map[string]any{"actionId": action},
		},
	}
}

func newRecordedGateway(
	t *testing.T,
	cfg config,
	verifier tokenVerifier,
	resolver connectorBindingResolver,
) (*mcpGateway, *tracetest.SpanRecorder, func()) {
	t.Helper()
	recorder := tracetest.NewSpanRecorder()
	provider := sdktrace.NewTracerProvider(
		sdktrace.WithSampler(sdktrace.AlwaysSample()),
		sdktrace.WithSpanProcessor(recorder),
	)
	observer := &gatewayObservability{
		provider:     provider,
		tracer:       provider.Tracer("test"),
		propagator:   propagation.NewCompositeTextMapPropagator(propagation.TraceContext{}, propagation.Baggage{}),
		hmacKey:      append([]byte(nil), cfg.observabilityHMACKey...),
		keyVersion:   cfg.observabilityKeyVersion,
		shutdownFunc: provider.Shutdown,
	}
	gateway := newMCPGatewayWithResolver(cfg, verifier, resolver)
	gateway.observe = observer
	gateway.proxy = gateway.newReverseProxy(cfg.upstreamURL)
	return gateway, recorder, func() { _ = provider.Shutdown(context.Background()) }
}

func findSpan(t *testing.T, spans []sdktrace.ReadOnlySpan, name string) sdktrace.ReadOnlySpan {
	t.Helper()
	for _, span := range spans {
		if span.Name() == name {
			return span
		}
	}
	t.Fatalf("span %q not found in %d spans", name, len(spans))
	return nil
}

func spanAttributes(span sdktrace.ReadOnlySpan) map[string]any {
	result := make(map[string]any)
	for _, value := range span.Attributes() {
		result[string(value.Key)] = value.Value.AsInterface()
	}
	return result
}

func assertNoSpanContains(t *testing.T, spans []sdktrace.ReadOnlySpan, forbidden ...string) {
	t.Helper()
	encoded, err := json.Marshal(spansToSafeView(spans))
	if err != nil {
		t.Fatal(err)
	}
	for _, value := range forbidden {
		if strings.Contains(string(encoded), value) {
			t.Fatalf("forbidden value %q entered telemetry: %s", value, encoded)
		}
	}
}

func spansToSafeView(spans []sdktrace.ReadOnlySpan) []any {
	result := make([]any, 0, len(spans))
	for _, span := range spans {
		events := make([]any, 0, len(span.Events()))
		for _, event := range span.Events() {
			events = append(events, map[string]any{"name": event.Name, "attributes": event.Attributes})
		}
		result = append(result, map[string]any{
			"name": span.Name(), "attributes": span.Attributes(), "events": events, "status": span.Status(),
		})
	}
	return result
}
