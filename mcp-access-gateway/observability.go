package main

import (
	"bytes"
	"context"
	"crypto/hmac"
	"crypto/sha256"
	"encoding/binary"
	"encoding/hex"
	"encoding/json"
	"errors"
	"io"
	"log/slog"
	"net/http"
	"strconv"
	"strings"
	"sync"
	"time"

	"go.opentelemetry.io/contrib/instrumentation/net/http/otelhttp"
	"go.opentelemetry.io/otel/attribute"
	"go.opentelemetry.io/otel/codes"
	"go.opentelemetry.io/otel/exporters/otlp/otlptrace/otlptracehttp"
	"go.opentelemetry.io/otel/propagation"
	"go.opentelemetry.io/otel/sdk/resource"
	sdktrace "go.opentelemetry.io/otel/sdk/trace"
	semconv "go.opentelemetry.io/otel/semconv/v1.34.0"
	"go.opentelemetry.io/otel/trace"
)

const (
	observabilityPrincipalDomain = "ai-base-observability-principal:v1"
	trafficOriginHeader          = "X-AI-Base-Traffic-Origin"
	publicMCPGatewayOrigin       = "public_mcp_gateway"
	maxObservedResponseBytes     = 256 << 10
	maxTrackedMCPMessages        = 128
	maxObservedMessageLifetime   = 5 * time.Minute
)

var externalTraceHeaders = []string{
	"traceparent", "tracestate", "baggage", "b3",
	"x-b3-traceid", "x-b3-spanid", "x-b3-parentspanid", "x-b3-sampled", "x-b3-flags",
	"x-request-id", "x-client-trace-id", "x-envoy-force-trace", "uber-trace-id",
	"ot-tracer-traceid", "ot-tracer-spanid", "ot-tracer-sampled",
	"grpc-trace-bin", "x-cloud-trace-context", "x-goog-cloud-trace-context",
	"x-ot-span-context", "x-amzn-trace-id",
	"agent-session-id", "x-session-id", "session-id",
	"x-user-id", "x-auth-request-user", "x-auth-request-email", "x-forwarded-user",
	trafficOriginHeader,
}

var traceMetaKeys = map[string]struct{}{
	"traceparent": {}, "tracestate": {}, "baggage": {}, "b3": {},
	"x-b3-traceid": {}, "x-b3-spanid": {}, "x-b3-parentspanid": {},
	"x-b3-sampled": {}, "x-b3-flags": {}, "x-request-id": {},
	"x-client-trace-id": {}, "x-envoy-force-trace": {}, "uber-trace-id": {},
	"ot-tracer-traceid": {}, "ot-tracer-spanid": {}, "ot-tracer-sampled": {},
	"grpc-trace-bin": {}, "x-cloud-trace-context": {}, "x-goog-cloud-trace-context": {},
	"x-ot-span-context": {}, "x-amzn-trace-id": {},
	"agent-session-id": {}, "x-session-id": {}, "session-id": {},
	"x-user-id": {}, "x-auth-request-user": {}, "x-auth-request-email": {}, "x-forwarded-user": {},
	"x-ai-base-traffic-origin": {},
	"trace_id":                 {}, "span_id": {}, "sampled": {},
}

var knownMCPMethods = map[string]struct{}{
	"initialize": {}, "ping": {},
	"tools/list": {}, "tools/call": {},
	"resources/list": {}, "resources/read": {}, "resources/templates/list": {}, "resources/subscribe": {}, "resources/unsubscribe": {},
	"prompts/list": {}, "prompts/get": {},
	"logging/setLevel": {}, "completion/complete": {},
	"notifications/initialized": {}, "notifications/cancelled": {}, "notifications/progress": {},
	"notifications/resources/list_changed": {}, "notifications/resources/updated": {},
	"notifications/tools/list_changed": {}, "notifications/prompts/list_changed": {},
}

var knownMetricDecisions = map[string]struct{}{"allow": {}, "deny": {}}

var knownMetricReasons = map[string]struct{}{
	"no_auth": {}, "account_bound": {}, "controlled_shared": {}, "global": {},
	"system_hard_deny": {}, "action_not_authorized": {}, "invalid_action_id": {},
	"connector_authorization_required": {}, "connector_binding_resolver_unavailable": {},
	"connector_binding_invalid": {}, "connector_selection_required": {}, "connector_not_authorized": {},
	"protected_batch_not_supported": {},
}

var knownMetricResults = map[string]struct{}{
	"success": {}, "error": {}, "denied": {}, "no_response_expected": {},
	"unobserved": {}, "upstream_unavailable": {}, "authentication_failed": {},
	"session_rejected": {}, "http_error": {},
}

// mcpSpanMetricsDimensionAttributes is the safe span-attribute allowlist for
// the MCP-only SpanMetrics pipeline. service.name remains a resource attribute;
// raw trace-detail attributes such as rpc.method, mcp.server.namespace,
// mcp.tool.detail, mcp.action, and mcp.result.detail must not be dimensions.
var mcpSpanMetricsDimensionAttributes = [...]string{
	"traffic.origin",
	"mcp.method.name",
	"mcp.server.name",
	"mcp.tool.name",
	"mcp.action.name",
	"mcp.decision",
	"mcp.reason",
	"mcp.result",
	"error.type",
}

type gatewayObservability struct {
	tracer       trace.Tracer
	provider     trace.TracerProvider
	propagator   propagation.TextMapPropagator
	hmacKey      []byte
	keyVersion   string
	shutdownFunc func(context.Context) error
}

func newGatewayObservability(cfg config) *gatewayObservability {
	propagator := propagation.NewCompositeTextMapPropagator(propagation.TraceContext{}, propagation.Baggage{})
	provider := trace.NewNoopTracerProvider()
	shutdown := func(context.Context) error { return nil }

	if cfg.otelExporterEndpoint != "" {
		ctx, cancel := context.WithTimeout(context.Background(), 5*time.Second)
		defer cancel()
		exporter, err := otlptracehttp.New(ctx, otlptracehttp.WithEndpointURL(cfg.otelExporterEndpoint))
		if err != nil {
			slog.Warn("OpenTelemetry exporter disabled", "error", err)
		} else {
			tp := sdktrace.NewTracerProvider(
				sdktrace.WithBatcher(exporter),
				sdktrace.WithSampler(sdktrace.AlwaysSample()),
				sdktrace.WithResource(gatewayResource()),
			)
			provider = tp
			shutdown = tp.Shutdown
		}
	}

	hmacKey := append([]byte(nil), cfg.observabilityHMACKey...)
	keyVersion := cfg.observabilityKeyVersion
	if len(hmacKey) > 0 && (len(hmacKey) < 32 || keyVersion == "") {
		slog.Warn("observability identity fingerprinting disabled", "reason", "HMAC key must contain at least 32 bytes and have a key version")
		hmacKey = nil
		keyVersion = ""
	}

	return &gatewayObservability{
		tracer:       provider.Tracer("github.com/aca952015/ai-base/mcp-access-gateway"),
		provider:     provider,
		propagator:   propagator,
		hmacKey:      hmacKey,
		keyVersion:   keyVersion,
		shutdownFunc: shutdown,
	}
}

func gatewayResource() *resource.Resource {
	return resource.NewSchemaless(semconv.ServiceName("ai-base-mcp-access-gateway"))
}

func (o *gatewayObservability) shutdown(ctx context.Context) error {
	return o.shutdownFunc(ctx)
}

func (o *gatewayObservability) publicRoot(next http.Handler) http.Handler {
	return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		receivedExternalContext := stripExternalTraceHeaders(r.Header)
		ctx, span := o.tracer.Start(
			r.Context(),
			"mcp.public.transaction",
			trace.WithNewRoot(),
			trace.WithSpanKind(trace.SpanKindServer),
			trace.WithAttributes(
				attribute.String("traffic.origin", publicMCPGatewayOrigin),
				attribute.Bool("mcp.external_context_received", receivedExternalContext),
			),
		)
		defer span.End()
		next.ServeHTTP(w, r.WithContext(ctx))
	})
}

func (o *gatewayObservability) preparePublicMessages(next http.Handler) http.Handler {
	return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if r.Method != http.MethodPost || r.Body == nil {
			next.ServeHTTP(w, r)
			return
		}
		body, err := io.ReadAll(io.LimitReader(r.Body, maxMCPRequestBody+1))
		_ = r.Body.Close()
		r.Body = io.NopCloser(bytes.NewReader(body))
		r.ContentLength = int64(len(body))
		if err != nil || len(body) > maxMCPRequestBody {
			next.ServeHTTP(w, r)
			return
		}
		body, tracker := o.prepareMessages(r.Context(), body, identity{})
		r.Body = io.NopCloser(bytes.NewReader(body))
		r.ContentLength = int64(len(body))
		next.ServeHTTP(w, r.WithContext(tracker.attach(r.Context())))
	})
}

func finishAuthenticationFailure(ctx context.Context, result string) {
	if tracker, _ := ctx.Value(messageTrackerContextKey{}).(*mcpMessageTracker); tracker != nil {
		tracker.finishUnmatched(result)
	}
}

func stripExternalTraceHeaders(header http.Header) bool {
	received := false
	for _, name := range externalTraceHeaders {
		if header.Values(name) != nil {
			received = true
		}
		header.Del(name)
	}
	for name := range header {
		lower := strings.ToLower(name)
		if strings.HasPrefix(lower, "x-b3-") || strings.HasPrefix(lower, "ot-tracer-") {
			received = true
			header.Del(name)
		}
	}
	return received
}

func (o *gatewayObservability) outboundTransport(base http.RoundTripper) http.RoundTripper {
	return otelhttp.NewTransport(
		base,
		otelhttp.WithTracerProvider(o.provider),
		otelhttp.WithPropagators(o.propagator),
	)
}

type messageTrackerContextKey struct{}

type mcpMessageTracker struct {
	mu       sync.Mutex
	observer *gatewayObservability
	records  map[string]*mcpMessageRecord
	ordered  []*mcpMessageRecord
	expiry   *time.Timer
}

type mcpMessageRecord struct {
	key          string
	span         trace.Span
	ctx          context.Context
	started      time.Time
	notification bool
	finished     bool
	decision     string
	reason       string
	service      string
	connection   string
	action       string
	caller       identity
}

func (o *gatewayObservability) prepareMessages(ctx context.Context, body []byte, caller identity) ([]byte, *mcpMessageTracker) {
	decoder := json.NewDecoder(bytes.NewReader(body))
	decoder.UseNumber()
	var payload any
	if err := decoder.Decode(&payload); err != nil {
		return body, nil
	}

	tracker := &mcpMessageTracker{observer: o, records: make(map[string]*mcpMessageRecord)}
	changed := sanitizeTraceMeta(payload)
	start := func(message map[string]any) {
		method, ok := message["method"].(string)
		if !ok || strings.TrimSpace(method) == "" {
			return
		}
		method = normalizedMCPMethod(method)
		key, hasID := jsonRPCIDKey(message["id"])
		messageCtx, span := o.tracer.Start(
			ctx,
			"mcp.server.message",
			trace.WithSpanKind(trace.SpanKindServer),
			trace.WithAttributes(
				attribute.String("traffic.origin", publicMCPGatewayOrigin),
				attribute.String("rpc.system", "jsonrpc"),
				attribute.String("rpc.method", method),
				attribute.String("mcp.method.name", method),
				attribute.String("mcp.server.namespace", "envoy-mcp-registry"),
				attribute.String("mcp.server.name", "__other__"),
				attribute.String("mcp.tool.name", "__other__"),
				attribute.String("mcp.action.name", "__other__"),
				attribute.String("mcp.decision", "other"),
				attribute.String("mcp.reason", "other"),
			),
		)
		if tool := requestToolDetail(message); tool != "" {
			span.SetAttributes(attribute.String("mcp.tool.detail", tool))
		}
		record := &mcpMessageRecord{
			key: key, span: span, ctx: messageCtx, started: time.Now(),
			notification: !hasID, caller: caller,
		}
		if len(tracker.ordered) >= maxTrackedMCPMessages {
			span.SetAttributes(
				attribute.Bool("mcp.observer.overflow", true),
				attribute.String("mcp.result", "unobserved"),
			)
			span.End()
			injectMessageContext(o.propagator, messageCtx, message)
			changed = true
			return
		}
		tracker.ordered = append(tracker.ordered, record)
		if hasID {
			tracker.records[key] = record
		}
		injectMessageContext(o.propagator, messageCtx, message)
		changed = true
	}

	switch typed := payload.(type) {
	case map[string]any:
		start(typed)
	case []any:
		for _, item := range typed {
			if message, ok := item.(map[string]any); ok {
				start(message)
			}
		}
	}
	if len(tracker.ordered) == 0 {
		return marshalIfChanged(body, payload, changed), nil
	}
	tracker.expiry = time.AfterFunc(maxObservedMessageLifetime, func() {
		tracker.finishUnmatched("unobserved")
	})
	return marshalIfChanged(body, payload, changed), tracker
}

func requestToolDetail(message map[string]any) string {
	params, _ := message["params"].(map[string]any)
	tool, _ := params["name"].(string)
	return boundedDiagnosticIdentifier(tool)
}

func normalizedMCPMethod(method string) string {
	method = strings.TrimSpace(method)
	if _, known := knownMCPMethods[method]; known {
		return method
	}
	return "__other__"
}

func sanitizeTraceMeta(value any) bool {
	changed := false
	switch typed := value.(type) {
	case map[string]any:
		for key, child := range typed {
			if key == "_meta" {
				if meta, ok := child.(map[string]any); ok {
					for metaKey := range meta {
						lower := strings.ToLower(metaKey)
						_, exact := traceMetaKeys[lower]
						if exact || strings.HasPrefix(lower, "x-b3-") || strings.HasPrefix(lower, "ot-tracer-") {
							delete(meta, metaKey)
							changed = true
						}
					}
				}
			}
			if sanitizeTraceMeta(child) {
				changed = true
			}
		}
	case []any:
		for _, child := range typed {
			if sanitizeTraceMeta(child) {
				changed = true
			}
		}
	}
	return changed
}

func injectMessageContext(propagator propagation.TextMapPropagator, ctx context.Context, message map[string]any) {
	params, ok := message["params"].(map[string]any)
	if !ok {
		params = make(map[string]any)
		message["params"] = params
	}
	meta, ok := params["_meta"].(map[string]any)
	if !ok {
		meta = make(map[string]any)
		params["_meta"] = meta
	}
	carrier := propagation.MapCarrier{}
	propagator.Inject(ctx, carrier)
	for key, value := range carrier {
		meta[key] = value
	}
}

func marshalIfChanged(original []byte, payload any, changed bool) []byte {
	if !changed {
		return original
	}
	updated, err := json.Marshal(payload)
	if err != nil {
		return original
	}
	return updated
}

func jsonRPCIDKey(value any) (string, bool) {
	if value == nil {
		return "", false
	}
	encoded, err := json.Marshal(value)
	if err != nil {
		return "", false
	}
	return string(encoded), true
}

func (t *mcpMessageTracker) attach(ctx context.Context) context.Context {
	if t == nil {
		return ctx
	}
	return context.WithValue(ctx, messageTrackerContextKey{}, t)
}

func messageContext(ctx context.Context, id any) context.Context {
	tracker, _ := ctx.Value(messageTrackerContextKey{}).(*mcpMessageTracker)
	if tracker == nil {
		return ctx
	}
	key, ok := jsonRPCIDKey(id)
	if !ok {
		return ctx
	}
	tracker.mu.Lock()
	defer tracker.mu.Unlock()
	if record := tracker.records[key]; record != nil {
		return context.WithValue(record.ctx, messageTrackerContextKey{}, tracker)
	}
	return ctx
}

func bindAuthenticatedCaller(ctx context.Context, caller identity) {
	tracker, _ := ctx.Value(messageTrackerContextKey{}).(*mcpMessageTracker)
	if tracker == nil {
		return
	}
	tracker.bindAuthenticatedCaller(caller)
}

func (t *mcpMessageTracker) bindAuthenticatedCaller(caller identity) {
	t.mu.Lock()
	defer t.mu.Unlock()
	for _, record := range t.ordered {
		if !record.finished {
			t.bindCallerLocked(record, caller)
		}
	}
}

func (t *mcpMessageTracker) bindCallerLocked(record *mcpMessageRecord, caller identity) {
	record.caller = caller
	record.caller.clientID = oauthClientSummary(caller.clientID)
	if record.caller.clientID != "" {
		record.span.SetAttributes(attribute.String("mcp.oauth.client_id", record.caller.clientID))
	}
	if fingerprint, version, ok := t.observer.principalFingerprint(caller); ok {
		record.span.SetAttributes(
			attribute.String("mcp.principal.fingerprint", fingerprint),
			attribute.String("mcp.principal.key_version", version),
		)
	}
}

func oauthClientSummary(clientID string) string {
	clientID = boundedDiagnosticIdentifier(clientID)
	switch {
	case clientID == "":
		return ""
	case clientID == "workbuddy":
		return "workbuddy"
	case strings.HasPrefix(clientID, "ai-base-"):
		return "ai-base-dcr"
	default:
		return "other"
	}
}

func recordConnectorDecision(ctx context.Context, caller identity, service, connection, tool, action, decision, reason string) {
	service = boundedDiagnosticIdentifier(service)
	tool = boundedDiagnosticIdentifier(tool)
	action = boundedDiagnosticIdentifier(action)
	tracker, _ := ctx.Value(messageTrackerContextKey{}).(*mcpMessageTracker)
	span := trace.SpanFromContext(ctx)
	span.SetAttributes(
		attribute.String("mcp.authorization.decision", decision),
		attribute.String("mcp.authorization.reason", reason),
		attribute.String("mcp.server.namespace", service),
		attribute.String("mcp.action", action),
		attribute.String("mcp.decision", normalizedMetricDecision(decision)),
		attribute.String("mcp.reason", normalizedMetricReason(reason)),
	)
	span.AddEvent("mcp.authorization.decision", trace.WithAttributes(
		attribute.String("decision", decision),
		attribute.String("reason", reason),
	))
	if tracker == nil {
		return
	}
	tracker.mu.Lock()
	defer tracker.mu.Unlock()
	for _, record := range tracker.ordered {
		if record.span == span {
			tracker.bindCallerLocked(record, caller)
			record.service = service
			record.action = action
			record.decision = decision
			record.reason = reason
			if decision == "allow" {
				connection = boundedDiagnosticIdentifier(connection)
				record.connection = connection
				record.span.SetAttributes(
					attribute.String("mcp.server.name", boundedMetricTarget(service)),
					attribute.String("mcp.tool.name", boundedMetricTarget(tool)),
					attribute.String("mcp.action.name", boundedMetricTarget(action)),
				)
				if connection != "" {
					record.span.SetAttributes(attribute.String("mcp.connection.name", connection))
				}
			}
			return
		}
	}
}

func normalizedMetricDecision(value string) string {
	if _, known := knownMetricDecisions[value]; known {
		return value
	}
	return "other"
}

func normalizedMetricReason(value string) string {
	if _, known := knownMetricReasons[value]; known {
		return value
	}
	return "other"
}

func normalizedMetricResult(value string) string {
	if strings.HasPrefix(value, "http_") {
		value = "http_error"
	}
	if _, known := knownMetricResults[value]; known {
		return value
	}
	return "other"
}

func boundedMetricTarget(value string) string {
	if value = boundedDiagnosticIdentifier(value); value == "" {
		return "__other__"
	}
	return value
}

func boundedDiagnosticIdentifier(value string) string {
	value = strings.TrimSpace(value)
	if value == "" || len(value) > 128 {
		return ""
	}
	for _, character := range value {
		if (character < 'a' || character > 'z') &&
			(character < '0' || character > '9') &&
			character != '_' && character != '-' && character != '.' && character != '/' {
			return ""
		}
	}
	return value
}

func (t *mcpMessageTracker) finishNotifications() {
	if t == nil {
		return
	}
	t.mu.Lock()
	defer t.mu.Unlock()
	for _, record := range t.ordered {
		if record.notification {
			t.finishLocked(record, "no_response_expected", 0, "")
		}
	}
}

func (t *mcpMessageTracker) observe(value any) {
	if t == nil {
		return
	}
	switch typed := value.(type) {
	case []any:
		for _, item := range typed {
			t.observe(item)
		}
	case map[string]any:
		key, ok := jsonRPCIDKey(typed["id"])
		if !ok {
			return
		}
		t.mu.Lock()
		record := t.records[key]
		if record != nil && !record.finished {
			result, code, class := classifyJSONRPCResponse(typed, record.decision)
			t.finishLocked(record, result, code, class)
		}
		t.mu.Unlock()
	}
}

func classifyJSONRPCResponse(response map[string]any, decision string) (string, int64, string) {
	if decision == "deny" {
		return "denied", 0, ""
	}
	if rpcError, ok := response["error"].(map[string]any); ok {
		code := numericCode(rpcError["code"])
		return "error", code, jsonRPCErrorClass(code)
	}
	if result, ok := response["result"].(map[string]any); ok {
		if isError, _ := result["isError"].(bool); isError {
			return "error", 0, "tool_error"
		}
	}
	return "success", 0, ""
}

func numericCode(value any) int64 {
	switch typed := value.(type) {
	case json.Number:
		result, _ := typed.Int64()
		return result
	case float64:
		return int64(typed)
	case int:
		return int64(typed)
	case int64:
		return typed
	default:
		return 0
	}
}

func jsonRPCErrorClass(code int64) string {
	switch {
	case code >= -32768 && code <= -32000:
		return "protocol_error"
	case code != 0:
		return "application_error"
	default:
		return "json_rpc_error"
	}
}

func (t *mcpMessageTracker) finishUnmatched(result string) {
	if t == nil {
		return
	}
	t.mu.Lock()
	defer t.mu.Unlock()
	for _, record := range t.ordered {
		if !record.finished {
			t.finishLocked(record, result, 0, "")
		}
	}
}

func (t *mcpMessageTracker) finishLocked(record *mcpMessageRecord, result string, errorCode int64, errorClass string) {
	if record.finished {
		return
	}
	record.finished = true
	record.span.SetAttributes(
		attribute.String("mcp.result", normalizedMetricResult(result)),
		attribute.String("mcp.result.detail", result),
	)
	if errorCode != 0 {
		record.span.SetAttributes(attribute.Int64("rpc.jsonrpc.error_code", errorCode))
	}
	if errorClass != "" {
		record.span.SetAttributes(attribute.String("error.type", errorClass))
	}
	if result == "upstream_unavailable" {
		record.span.SetAttributes(attribute.String("error.type", "upstream_unavailable"))
	}
	if strings.HasPrefix(result, "http_") {
		record.span.SetAttributes(attribute.String("error.type", "upstream_http_error"))
	}
	if result == "error" || result == "upstream_unavailable" || strings.HasPrefix(result, "http_") {
		record.span.SetStatus(codes.Error, result)
	}
	record.span.End()
	if t.expiry != nil && t.allFinishedLocked() {
		t.expiry.Stop()
	}

	if record.decision != "" {
		attrs := []any{
			"client_id", record.caller.clientID,
			"service", record.service,
			"connection", record.connection,
			"action", record.action,
			"decision", record.decision,
			"reason", record.reason,
			"result", result,
			"duration_ms", time.Since(record.started).Milliseconds(),
		}
		if spanContext := record.span.SpanContext(); spanContext.IsValid() {
			attrs = append(attrs, "trace_id", spanContext.TraceID().String())
		}
		if fingerprint, version, ok := t.observer.principalFingerprint(record.caller); ok {
			attrs = append(attrs, "principal", fingerprint, "principal_key_version", version)
		}
		slog.Info("connector authorization decision", attrs...)
	}
}

func (t *mcpMessageTracker) allFinishedLocked() bool {
	for _, record := range t.ordered {
		if !record.finished {
			return false
		}
	}
	return true
}

func (o *gatewayObservability) principalFingerprint(caller identity) (string, string, bool) {
	if len(o.hmacKey) < 32 || o.keyVersion == "" {
		return "", "", false
	}
	mac := hmac.New(sha256.New, o.hmacKey)
	_, _ = mac.Write([]byte(observabilityPrincipalDomain))
	writeLengthPrefixed(mac, []byte(caller.issuer))
	writeLengthPrefixed(mac, []byte(caller.subject))
	digest := mac.Sum(nil)
	return hex.EncodeToString(digest[:16]), o.keyVersion, true
}

type hashWriter interface {
	Write([]byte) (int, error)
}

func writeLengthPrefixed(writer hashWriter, value []byte) {
	var size [4]byte
	binary.BigEndian.PutUint32(size[:], uint32(len(value)))
	_, _ = writer.Write(size[:])
	_, _ = writer.Write(value)
}

type observedResponseBody struct {
	body        io.ReadCloser
	tracker     *mcpMessageTracker
	contentType string
	buffer      bytes.Buffer
	ssePending  []byte
	overflow    bool
	closed      bool
}

func observeResponseBody(response *http.Response, tracker *mcpMessageTracker) {
	if tracker == nil || response.Body == nil {
		return
	}
	response.Body = &observedResponseBody{
		body: response.Body, tracker: tracker, contentType: response.Header.Get("Content-Type"),
	}
}

func (b *observedResponseBody) Read(target []byte) (int, error) {
	n, err := b.body.Read(target)
	if n > 0 && !b.overflow {
		if b.isSSE() {
			b.observeSSEChunk(target[:n])
		} else if b.buffer.Len()+n > maxObservedResponseBytes {
			b.buffer.Reset()
			b.overflow = true
		} else {
			_, _ = b.buffer.Write(target[:n])
		}
	}
	if errors.Is(err, io.EOF) {
		b.complete()
	}
	return n, err
}

func (b *observedResponseBody) Close() error {
	b.complete()
	return b.body.Close()
}

func (b *observedResponseBody) complete() {
	if b.closed {
		return
	}
	b.closed = true
	if b.isSSE() {
		b.observeSSELine(bytes.TrimSpace(b.ssePending))
		b.ssePending = nil
	} else if !b.overflow {
		observeResponseBytes(b.tracker, b.contentType, b.buffer.Bytes())
	}
	b.buffer.Reset()
	b.tracker.finishUnmatched("unobserved")
}

func (b *observedResponseBody) isSSE() bool {
	return strings.Contains(strings.ToLower(b.contentType), "text/event-stream")
}

func (b *observedResponseBody) observeSSEChunk(chunk []byte) {
	b.ssePending = append(b.ssePending, chunk...)
	for {
		newline := bytes.IndexByte(b.ssePending, '\n')
		if newline < 0 {
			break
		}
		b.observeSSELine(bytes.TrimSpace(b.ssePending[:newline]))
		b.ssePending = b.ssePending[newline+1:]
	}
	if len(b.ssePending) > maxObservedResponseBytes {
		b.ssePending = nil
		b.overflow = true
	}
}

func (b *observedResponseBody) observeSSELine(line []byte) {
	if bytes.HasPrefix(line, []byte("data:")) {
		decodeAndObserve(b.tracker, bytes.TrimSpace(bytes.TrimPrefix(line, []byte("data:"))))
	}
}

func observeResponseBytes(tracker *mcpMessageTracker, contentType string, body []byte) {
	if strings.Contains(strings.ToLower(contentType), "text/event-stream") {
		for _, line := range bytes.Split(body, []byte("\n")) {
			line = bytes.TrimSpace(line)
			if !bytes.HasPrefix(line, []byte("data:")) {
				continue
			}
			decodeAndObserve(tracker, bytes.TrimSpace(bytes.TrimPrefix(line, []byte("data:"))))
		}
		return
	}
	decodeAndObserve(tracker, body)
}

func decodeAndObserve(tracker *mcpMessageTracker, body []byte) {
	decoder := json.NewDecoder(bytes.NewReader(body))
	decoder.UseNumber()
	var payload any
	if err := decoder.Decode(&payload); err == nil {
		tracker.observe(payload)
	}
}

func (t *mcpMessageTracker) responseStatus(status int) {
	if status >= http.StatusBadRequest {
		t.finishUnmatched("http_" + strconv.Itoa(status))
	}
}
