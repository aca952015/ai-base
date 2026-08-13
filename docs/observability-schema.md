# AI Base observability telemetry contract

Contract version: `ai-base-observability-v1`

Status: implemented v1 contract. The initial capability probe proved model latency and Token families but did not prove a canonical model error dimension or TTFT family; those two KPIs intentionally remain unavailable.

## Gate and probe modes

`scripts/observability-probe.sh` is non-destructive by default. With no arguments it checks the repository contract, the exact gateway image pin, and deterministic HMAC fixtures; it does not start containers, send requests, or query a running service. `--live` is reserved for an isolated probe gateway and fails closed unless it receives a metrics endpoint, raw span-attribute inventory, a non-secret sentinel, and comparable metric snapshots taken before and after the 1,000-random-unknown-model workload.

`scripts/test-observability-integration.sh` is the repeatable Compose integration gate. It requires a running local stack and a configured test model, sends real public model/MCP forged carriers plus management and internal-Envoy fixtures, injects a content-bearing sentinel span, queries Jaeger/Prometheus/admin Console APIs and ordinary logs, then restarts Jaeger and proves the same Badger-backed Trace remains queryable. It never deletes volumes.

The fixed gateway image is `envoyproxy/ai-gateway-cli:v1.0.0`; the sanitizing gateway in front of Jaeger is `otel/opentelemetry-collector-contrib:0.135.0`. A live probe must prove that the model gateway executable recognizes all of the following names before configuration is merged:

- OTLP: `OTEL_EXPORTER_OTLP_ENDPOINT`, `OTEL_EXPORTER_OTLP_TRACES_ENDPOINT`, `OTEL_EXPORTER_OTLP_METRICS_ENDPOINT`, `OTEL_PROPAGATORS`, `OTEL_TRACES_SAMPLER`.
- Content suppression: `OPENINFERENCE_HIDE_INPUTS`, `OPENINFERENCE_HIDE_OUTPUTS`, `OPENINFERENCE_HIDE_EMBEDDINGS_TEXT`, `OPENINFERENCE_HIDE_EMBEDDINGS_VECTORS`.

Merely accepting an environment variable is not evidence that it changes exported telemetry. The raw span inventory and sentinel test are the semantic proof. If a name is absent or its effect cannot be proved, the gate fails and PR2 must not silently configure it.

## Canonical services, spans, and origin

| Boundary | `service.name` | Canonical span | `traffic.origin` |
| --- | --- | --- | --- |
| Envoy model gateway | `ai-base-llm-gateway` | upstream-probed GenAI server span | `external_gateway` or `internal_service` |
| Go public MCP gateway | `ai-base-mcp-access-gateway` | `mcp.server.message` | `public_mcp_gateway` |
| Envoy internal MCP | `ai-base-llm-gateway` | upstream-probed MCP protocol span | `internal_envoy` |
| Console connectivity test | originating management span only | not a business call | `management_probe` |

Only the Go `mcp.server.message` span counts public OAuth MCP JSON-RPC messages. Its downstream Envoy and HTTP spans are trace detail, not another KPI. Internal Envoy MCP spans count only when `traffic.origin=internal_envoy`; spans carrying the server-sealed public origin are excluded. `management_probe` is excluded from all business KPI queries.

Sampling is 100% head sampling. Trace availability remains best-effort and is never an audit or billing guarantee.

## Metric inventory and KPI ownership

The v1.0.0 standalone Prometheus exporter uses cumulative Prometheus histograms (the process resets the cumulative value when it restarts). The PR1 live inventory found these model families:

| Canonical family | Type / temporality | Allowed labels |
| --- | --- | --- |
| `gen_ai_server_request_duration_seconds` | histogram / cumulative | `gen_ai_operation_name`, `gen_ai_original_model`, `gen_ai_provider_name`, `gen_ai_request_model`, `gen_ai_response_model`, `otel_scope_name`, `otel_scope_schema_url`, `otel_scope_version`, `traffic_origin`, `le` |
| `gen_ai_client_token_usage` | histogram / cumulative | the labels above plus `gen_ai_token_type` (`input` or `output`) |

`gen_ai_original_model` is the configured public alias only if the unknown-model probe proves it bounded. An arbitrary client model in that label fails the series gate. `trace_id`, `span_id`, principal fingerprints, OAuth client, request/session IDs, connection/resource summaries, arbitrary headers, and raw error text are forbidden labels.

Metric families not observed in the fixture are not guessed. In particular, v1.0.0 did not establish a canonical error dimension or TTFT family in the initial non-streaming inventory. Until success/error/streaming probes prove them, model error rate and TTFT return “unavailable”, and PR2 is blocked from claiming those KPI.

### Fixed model PromQL

These are the only approved model templates for the currently proven families. `$range` is a server-selected enum (`15m`, `1h`, `24h`, `7d`), never browser-supplied PromQL.

- Calls: `sum(increase(gen_ai_server_request_duration_seconds_count{otel_scope_name="envoyproxy/ai-gateway",traffic_origin!="management_probe"}[$range]))`
- P50/P95/P99: `histogram_quantile($q, sum by (le) (rate(gen_ai_server_request_duration_seconds_bucket{otel_scope_name="envoyproxy/ai-gateway",traffic_origin!="management_probe"}[$range])))`, where `$q` is one of `0.50`, `0.95`, `0.99`.
- Input/output Token: `sum(increase(gen_ai_client_token_usage_sum{otel_scope_name="envoyproxy/ai-gateway",traffic_origin!="management_probe",gen_ai_token_type="$type"}[$range]))`, where `$type` is `input` or `output`.
- Calls or latency by model/provider: add only server-controlled grouping over `gen_ai_response_model` and/or `gen_ai_provider_name`.

Model error rate and TTFT have no approved query until a repeatable live fixture supplies a bounded status/error label and TTFT metric. Token is never derived from Trace, request size, or character count.

MCP KPI are owned by the MCP-only SpanMetrics pipeline described above. The validated Jaeger 2.19 connector exports cumulative `mcp_duration_milliseconds` histogram and `mcp_calls_total` counter families. Calls use the histogram `_count`, whose first ingested span was observed immediately; `mcp_calls_total` is retained for Jaeger SPM compatibility but is not the Console KPI source. The only custom dimension labels are `traffic_origin`, `mcp_method_name`, `mcp_server_name`, `mcp_tool_name`, `mcp_action_name`, `mcp_decision`, `mcp_reason`, `mcp_result`, and `error_type`; connector-owned `service_name`, `span_name`, `span_kind`, `status_code`, scope, job, collector instance, and histogram `le` labels are also present.

### Fixed MCP PromQL

- Calls: `sum(increase(mcp_duration_milliseconds_count{span_name="mcp.server.message",traffic_origin!="management_probe"}[$range]))`.
- Denied rate: `sum(increase(mcp_duration_milliseconds_count{span_name="mcp.server.message",traffic_origin!="management_probe",mcp_decision="deny"}[$range])) / clamp_min(sum(increase(mcp_duration_milliseconds_count{span_name="mcp.server.message",traffic_origin!="management_probe"}[$range])), 1)`.
- Upstream/protocol error rate: `sum(increase(mcp_duration_milliseconds_count{span_name="mcp.server.message",traffic_origin!="management_probe",mcp_result=~"error|upstream_unavailable|http_error"}[$range])) / clamp_min(sum(increase(mcp_duration_milliseconds_count{span_name="mcp.server.message",traffic_origin!="management_probe"}[$range])), 1)`.
- P50/P95/P99: `histogram_quantile($q, sum by (le) (rate(mcp_duration_milliseconds_bucket{span_name="mcp.server.message",traffic_origin!="management_probe"}[$range])))`, where `$q` is one of `0.50`, `0.95`, `0.99`.

`mcp.server.name`, tool, and action labels start as `__other__` and are populated only after the server has successfully authorized the resolved target. Arbitrary rejected values never enter a metric label.

## Series budgets

- At most 5,000 active Prometheus series per canonical family.
- At most 20,000 active series across all observability families added by this initiative.
- After 1,000 distinct unknown client model names, each canonical model family may add at most 10 series compared with a same-process baseline.
- The before/after snapshots must come from the same isolated process and configuration. A reset, scrape-format change, or decreased count is not comparable and fails.

The probe counts physical Prometheus series, including histogram buckets. Exceeding a budget blocks direct Envoy-to-Prometheus ingestion; memory increases are not an accepted workaround.

## Carrier scrub contract

Public Caddy removes these HTTP headers case-insensitively before forwarding. The Go public MCP gateway repeats the removal before any extraction, creates a new root, and only then injects platform-owned downstream context:

- W3C: `traceparent`, `tracestate`, `baggage`.
- B3: `b3`, `x-b3-traceid`, `x-b3-spanid`, `x-b3-parentspanid`, `x-b3-sampled`, `x-b3-flags`.
- Other propagators: `uber-trace-id`, `x-ot-span-context`, `ot-tracer-traceid`, `ot-tracer-spanid`, `ot-tracer-sampled`, `grpc-trace-bin`, `x-cloud-trace-context`, `x-goog-cloud-trace-context`, `x-amzn-trace-id`.
- Envoy/request sampling: `x-request-id`, `x-client-trace-id`, `x-envoy-force-trace`.
- Automatically mapped correlation or identity: `agent-session-id`, `x-session-id`, `session-id`, `x-user-id`, `x-auth-request-user`, `x-auth-request-email`, `x-forwarded-user`.

For MCP JSON-RPC, the same logical names under `params._meta`, top-level `_meta`, or protocol extension metadata are deleted before server-owned metadata is added. Client `sampled=0`, debug/force bits, parent IDs, request-ID reason bits, and baggage must not change the new root or 100% platform sampling. Any carrier discovered by the live inventory is added here before PR2/PR3.

These carriers are observability inputs only. A server-sealed `traffic.origin` is generated after scrubbing and never participates in authorization.

## Principal fingerprint and fixed fixtures

The principal fingerprint is:

```text
HMAC-SHA-256(
  key,
  "ai-base-observability-principal:v1" ||
  u32be(len(issuer_utf8)) || issuer_utf8 ||
  u32be(len(subject_utf8)) || subject_utf8
)[0:16] as lowercase hex
```

`issuer` and `subject` are the original UTF-8 bytes from verified claims; no trim, Unicode normalization, or case-folding occurs. The key is a stable, observability-only secret identified by `key_version`. Metrics never contain this fingerprint. Rotation does not automatically link old and new fingerprints.

Fixture key (test data only): `000102030405060708090a0b0c0d0e0f101112131415161718191a1b1c1d1e1f`.

| issuer | subject | 16-byte digest prefix |
| --- | --- | --- |
| `ab` | `c` | `7402309d2d8c4bf12a1e78815b51caf5` |
| `a` | `bc` | `43f992c377fe8dbc03afbac4fbf95306` |

The distinct outputs are a required regression against ambiguous concatenation.

## Trace field allowlist

Allowed model detail fields: trace/span/parent IDs; start/end/duration; `service.name`; safe Agent/run ID; operation; configured request alias; resolved response model; provider/backend; streaming; finish reason; status; classified `error.type`; TTFT and numeric Token usage when supplied; request/response byte counts.

Allowed MCP detail fields: trace/span IDs; source service; protocol version and method; server namespace; normalized tool/action; connection display summary; principal fingerprint and key version; OAuth client summary; allow/deny and enumerated reason; upstream status; classified error type; duration; result class.

Allowed decisions are `allow` and `deny`. Metric reason codes are `no_auth`, `account_bound`, `controlled_shared`, `global`, `system_hard_deny`, `action_not_authorized`, `invalid_action_id`, `connector_authorization_required`, `connector_binding_resolver_unavailable`, `connector_binding_invalid`, `connector_selection_required`, `connector_not_authorized`, and `protected_batch_not_supported`. Result codes are `success`, `error`, `denied`, `no_response_expected`, `unobserved`, `upstream_unavailable`, `authentication_failed`, `session_rejected`, and `http_error`. Unknown values map to `other`; raw messages never become attributes or labels.

## Forbidden fields and prefixes

The collection source and Jaeger redaction pipeline both remove the following exact keys or prefixes, case-insensitively where the protocol permits:

- OTel GenAI: `gen_ai.input.messages`, `gen_ai.output.messages`, `gen_ai.system_instructions`, `gen_ai.tool.definitions`, `gen_ai.tool.call.arguments`, `gen_ai.tool.call.result`, `gen_ai.retrieval.query.text`.
- OpenInference: `input.*`, `output.*`, `llm.input_messages.*`, `llm.output_messages.*`, `llm.prompts`, `llm.choices`, `embedding.*`.
- HTTP/RPC: any authorization, proxy-authorization, cookie, set-cookie, body, query, full URL/URI, JSON-RPC request/response, tool arguments/result, header map, request/response payload, or exception stack/message containing business data.
- Identity/session/secrets: access or refresh Token, API key, secret, password, raw OIDC claim, raw issuer/subject, enterprise WeCom UserID, session ID, connection credential, knowledge/message body, and full resource URI.

The pinned OpenTelemetry Collector in front of Jaeger removes all span events and clears `status.message` while retaining its enumerated status code; Jaeger repeats the event and attribute filters before both storage and SpanMetrics. All first-party exporters target the Collector rather than Jaeger's receiver directly. An unclassified new attribute whose name or value may carry content is a gate failure. The sentinel must be absent from Jaeger API output, Prometheus labels, Console API/browser responses, and ordinary logs. Console adapters map explicit internal DTO fields only and never pass through arbitrary tags, events, logs, or upstream error text.
