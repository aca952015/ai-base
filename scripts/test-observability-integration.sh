#!/usr/bin/env bash
set -euo pipefail

readonly ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
readonly MODEL_ALIAS="${OBSERVABILITY_TEST_MODEL:-Qwen-AgentWorld-35B-A3B}"
readonly FORGED_TRACE_ID="11111111111111111111111111111111"
readonly FORGED_SPAN_ID="2222222222222222"
readonly SENTINEL="AI_BASE_PRIVATE_SENTINEL_$(date -u +%Y%m%dT%H%M%SZ)_${RANDOM}"

cd "$ROOT"

for command in curl docker node python3; do
  command -v "$command" >/dev/null 2>&1 || {
    printf 'FAIL: required command not found: %s\n' "$command" >&2
    exit 1
  }
done

temporary_dir="$(mktemp -d "${TMPDIR:-/tmp}/ai-base-observability-integration.XXXXXX")"
trap 'rm -rf "$temporary_dir"' EXIT

started_at="$(date -u +%Y-%m-%dT%H:%M:%SZ)"
started_epoch_ms="$(python3 - "$started_at" <<'PY'
from datetime import datetime
import sys
print(int(datetime.fromisoformat(sys.argv[1].replace("Z", "+00:00")).timestamp() * 1000))
PY
)"

for service in ai-console agent-runtime global-gateway llm-gateway mcp-access-gateway otel-collector jaeger prometheus; do
  if ! docker compose ps --status running --services | grep -Fqx "$service"; then
    printf 'FAIL: docker compose service is not running: %s\n' "$service" >&2
    exit 1
  fi
done

internal_get() {
  docker compose exec -T ai-console node - "$1" <<'NODE'
const url = process.argv[2];
fetch(url).then(async (response) => {
  const body = await response.text();
  process.stdout.write(body);
  if (!response.ok) {
    process.stderr.write(`\nGET ${url} returned ${response.status}\n`);
    process.exit(1);
  }
}).catch((error) => {
  process.stderr.write(`${error.name}: ${error.message}\n`);
  process.exit(1);
});
NODE
}

prom_value() {
  docker compose exec -T ai-console node - "$1" <<'NODE'
const query = process.argv[2];
const url = new URL("http://prometheus:9090/api/v1/query");
url.searchParams.set("query", query);
fetch(url).then(async (response) => {
  const payload = await response.json();
  if (!response.ok || payload.status !== "success") process.exit(1);
  const value = payload.data?.result?.[0]?.value?.[1] ?? "0";
  process.stdout.write(String(value));
}).catch(() => process.exit(1));
NODE
}

sign_admin_assertion() {
  node - "$ROOT/deploy/pomerium/dev-signing-key.pem" <<'NODE'
const { readFileSync } = require("node:fs");
const { sign } = require("node:crypto");
const key = readFileSync(process.argv[2], "utf8");
const encode = (value) => Buffer.from(JSON.stringify(value)).toString("base64url");
const now = Math.floor(Date.now() / 1000);
const header = encode({ alg: "ES256", typ: "JWT" });
const payload = encode({
  aud: "ai-console.localhost.pomerium.io",
  exp: now + 300,
  nbf: now - 10,
  sub: "observability-integration-admin",
  email: "admin@bluetron.cn",
  name: "Observability Integration",
});
const signingInput = `${header}.${payload}`;
const signature = sign("sha256", Buffer.from(signingInput), {
  key,
  dsaEncoding: "ieee-p1363",
}).toString("base64url");
process.stdout.write(`${signingInput}.${signature}`);
NODE
}

console_get() {
  docker compose exec -T -e OBSERVABILITY_TEST_ASSERTION="$admin_assertion" ai-console node - "$1" <<'NODE'
const url = process.argv[2];
fetch(url, { headers: { "x-pomerium-jwt-assertion": process.env.OBSERVABILITY_TEST_ASSERTION } })
  .then(async (response) => {
    const body = await response.text();
    process.stdout.write(body);
    if (!response.ok) {
      process.stderr.write(`\nConsole API ${url} returned ${response.status}\n`);
      process.exit(1);
    }
  }).catch((error) => {
    process.stderr.write(`${error.name}: ${error.message}\n`);
    process.exit(1);
  });
NODE
}

admin_assertion="$(sign_admin_assertion)"

model_business_before="$(prom_value 'sum(gen_ai_server_request_duration_seconds_count{traffic_origin!="management_probe"})')"
model_all_before="$(prom_value 'sum(gen_ai_server_request_duration_seconds_count)')"
model_management_before="$(prom_value 'sum(gen_ai_server_request_duration_seconds_count{traffic_origin="management_probe"})')"
model_management_tokens_before="$(prom_value 'sum(gen_ai_client_token_usage_sum{traffic_origin="management_probe"})')"
mcp_internal_before="$(prom_value 'sum(mcp_duration_milliseconds_count{traffic_origin="internal_envoy"})')"

carrier_headers=()
while IFS= read -r carrier; do
  value="$FORGED_TRACE_ID"
  case "$carrier" in
    traceparent) value="00-${FORGED_TRACE_ID}-${FORGED_SPAN_ID}-00" ;;
    b3) value="${FORGED_TRACE_ID}-${FORGED_SPAN_ID}-0" ;;
    x-b3-spanid|x-b3-parentspanid|ot-tracer-spanid) value="$FORGED_SPAN_ID" ;;
    x-b3-sampled|ot-tracer-sampled) value="0" ;;
    x-b3-flags|x-envoy-force-trace) value="1" ;;
  esac
  carrier_headers+=(--header "${carrier}: ${value}")
done < <(scripts/observability-probe.sh --list-carriers)

model_status="$(curl --silent --show-error --output "$temporary_dir/model-response.json" --write-out '%{http_code}' \
  --request POST http://127.0.0.1:8080/v1/chat/completions \
  --header 'Authorization: Bearer ai-base-internal' \
  --header 'Content-Type: application/json' \
  "${carrier_headers[@]}" \
  --data "{\"model\":\"${MODEL_ALIAS}\",\"max_tokens\":1,\"messages\":[{\"role\":\"user\",\"content\":\"${SENTINEL}\"}]}" \
  --max-time 60)"
[[ "$model_status" == "200" ]] || {
  printf 'FAIL: public model carrier fixture returned HTTP %s\n' "$model_status" >&2
  exit 1
}

docker compose exec -T ai-console node - "$MODEL_ALIAS" "$SENTINEL" <<'NODE'
const model = process.argv[2];
const sentinel = process.argv[3];
fetch("http://llm-gateway:1975/v1/chat/completions", {
  method: "POST",
  headers: {
    Authorization: "Bearer ai-base-internal",
    "Content-Type": "application/json",
    "X-AI-Base-Traffic-Origin": "management_probe",
  },
  body: JSON.stringify({ model, max_tokens: 1, messages: [{ role: "user", content: sentinel }] }),
  signal: AbortSignal.timeout(60000),
}).then(async (response) => {
  await response.arrayBuffer();
  if (!response.ok) {
    process.stderr.write(`management model fixture returned ${response.status}\n`);
    process.exit(1);
  }
}).catch((error) => {
  process.stderr.write(`${error.name}: ${error.message}\n`);
  process.exit(1);
});
NODE

carrier_csv="$(scripts/observability-probe.sh --list-carriers | paste -sd, -)"
node - "$carrier_csv" "$FORGED_TRACE_ID" "$SENTINEL" >"$temporary_dir/mcp-request.json" <<'NODE'
const carriers = process.argv[2].split(",");
const forged = process.argv[3];
const sentinel = process.argv[4];
const metadata = Object.fromEntries(carriers.map((carrier) => [carrier, forged]));
metadata.traceparent = `00-${forged}-2222222222222222-00`;
metadata.sentinel = sentinel;
process.stdout.write(JSON.stringify({
  jsonrpc: "2.0",
  id: 1,
  method: "ping",
  _meta: metadata,
  params: { _meta: metadata },
}));
NODE

mcp_status="$(curl --silent --show-error --output "$temporary_dir/mcp-response.json" --write-out '%{http_code}' \
  --request POST http://127.0.0.1:8080/mcp \
  --header 'Content-Type: application/json' \
  "${carrier_headers[@]}" \
  --data-binary "@$temporary_dir/mcp-request.json" \
  --max-time 30)"
[[ "$mcp_status" == "401" || "$mcp_status" == "403" ]] || {
  printf 'FAIL: unauthenticated MCP carrier fixture returned HTTP %s\n' "$mcp_status" >&2
  exit 1
}

docker compose exec -T ai-console node - "$SENTINEL" <<'NODE'
const sentinel = process.argv[2];
fetch("http://llm-gateway:1975/mcp", {
  method: "POST",
  headers: {
    Accept: "application/json, text/event-stream",
    "Content-Type": "application/json",
    "X-AI-Base-Traffic-Origin": "internal_envoy",
  },
  body: JSON.stringify({
    jsonrpc: "2.0",
    id: 1,
    method: "initialize",
    params: {
      protocolVersion: "2025-06-18",
      capabilities: {},
      clientInfo: { name: "ai-base-observability-integration", version: "1" },
      _meta: { sentinel },
    },
  }),
  signal: AbortSignal.timeout(30000),
}).then(async (response) => {
  await response.arrayBuffer();
  if (!response.ok) {
    process.stderr.write(`internal Envoy MCP fixture returned ${response.status}\n`);
    process.exit(1);
  }
}).catch((error) => {
  process.stderr.write(`${error.name}: ${error.message}\n`);
  process.exit(1);
});
NODE

sentinel_trace_id="$(docker compose exec -T -e PRIVATE_SENTINEL="$SENTINEL" agent-runtime python - <<'PY'
import os
from opentelemetry import trace
from opentelemetry.exporter.otlp.proto.http.trace_exporter import OTLPSpanExporter
from opentelemetry.sdk.resources import Resource
from opentelemetry.sdk.trace import TracerProvider
from opentelemetry.sdk.trace.export import SimpleSpanProcessor
from opentelemetry.trace import Status, StatusCode

provider = TracerProvider(resource=Resource.create({"service.name": "ai-base-observability-sentinel"}))
provider.add_span_processor(SimpleSpanProcessor(OTLPSpanExporter(endpoint="http://otel-collector:4318/v1/traces")))
tracer = provider.get_tracer("ai-base.observability.integration")
with tracer.start_as_current_span("privacy.sentinel") as span:
    trace_id = f"{span.get_span_context().trace_id:032x}"
    span.set_attribute("input.value", os.environ["PRIVATE_SENTINEL"])
    span.set_attribute("safe.fixture", "privacy-redaction")
    span.add_event("exception", {
        "exception.message": os.environ["PRIVATE_SENTINEL"],
        "exception.stacktrace": os.environ["PRIVATE_SENTINEL"],
    })
    span.set_status(Status(StatusCode.ERROR, os.environ["PRIVATE_SENTINEL"]))
provider.shutdown()
print(trace_id)
PY
)"

wait_for_trace() {
  local trace_id="$1" output="$2"
  for _ in $(seq 1 30); do
    if internal_get "http://jaeger:16686/api/v3/traces/${trace_id}" >"$output" 2>/dev/null \
      && python3 - "$output" <<'PY'
import json, sys
payload = json.load(open(sys.argv[1], encoding="utf-8"))
spans = payload.get("result", {}).get("resourceSpans", [])
raise SystemExit(0 if spans else 1)
PY
    then
      return 0
    fi
    sleep 2
  done
  printf 'FAIL: trace did not become queryable: %s\n' "$trace_id" >&2
  return 1
}

wait_for_trace "$sentinel_trace_id" "$temporary_dir/sentinel-trace.json"

python3 - "$temporary_dir/sentinel-trace.json" "$SENTINEL" <<'PY'
import json, sys
payload = json.load(open(sys.argv[1], encoding="utf-8"))
serialized = json.dumps(payload, ensure_ascii=False)
if sys.argv[2] in serialized:
    raise SystemExit("sensitive sentinel survived in Jaeger API output")

def walk(value):
    if isinstance(value, dict):
        for key, child in value.items():
            if key in {"events", "spanEvents", "span_events"} and child:
                raise SystemExit("span events survived the collector")
            if key == "status" and isinstance(child, dict) and child.get("message"):
                raise SystemExit("span status message survived the collector")
            walk(child)
    elif isinstance(value, list):
        for child in value:
            walk(child)

walk(payload)
PY

deadline=$((SECONDS + 75))
while true; do
  model_business_after="$(prom_value 'sum(gen_ai_server_request_duration_seconds_count{traffic_origin!="management_probe"})')"
  model_all_after="$(prom_value 'sum(gen_ai_server_request_duration_seconds_count)')"
  model_management_after="$(prom_value 'sum(gen_ai_server_request_duration_seconds_count{traffic_origin="management_probe"})')"
  model_management_tokens_after="$(prom_value 'sum(gen_ai_client_token_usage_sum{traffic_origin="management_probe"})')"
  mcp_internal_after="$(prom_value 'sum(mcp_duration_milliseconds_count{traffic_origin="internal_envoy"})')"
  if python3 - "$model_business_before" "$model_business_after" "$model_all_before" "$model_all_after" \
    "$model_management_before" "$model_management_after" "$model_management_tokens_before" \
    "$model_management_tokens_after" "$mcp_internal_before" "$mcp_internal_after" <<'PY'
import sys
values = list(map(float, sys.argv[1:]))
business_before, business_after, all_before, all_after, management_before, management_after, token_before, token_after, mcp_before, mcp_after = values
ok = (
    business_after - business_before >= 1
    and all_after - all_before >= 2
    and management_after - management_before >= 1
    and token_after - token_before > 0
    and mcp_after - mcp_before >= 1
)
raise SystemExit(0 if ok else 1)
PY
  then
    break
  fi
  if ((SECONDS >= deadline)); then
    printf 'FAIL: Prometheus did not observe separated model origins and internal MCP metrics\n' >&2
    exit 1
  fi
  sleep 3
done

to_iso="$(date -u +%Y-%m-%dT%H:%M:%SZ)"
encoded_window="$(node - "$started_at" "$to_iso" <<'NODE'
const p = new URLSearchParams({ from: process.argv[2], to: process.argv[3], limit: "100" });
process.stdout.write(p.toString());
NODE
)"
console_get "http://127.0.0.1:3000/api/observability/summary?range=15m" >"$temporary_dir/console-summary.json"
console_get "http://127.0.0.1:3000/api/observability/calls?kind=model&${encoded_window}" >"$temporary_dir/console-model-calls.json"
console_get "http://127.0.0.1:3000/api/observability/calls?kind=mcp&${encoded_window}" >"$temporary_dir/console-mcp-calls.json"
console_get "http://127.0.0.1:3000/api/observability/traces/${sentinel_trace_id}" >"$temporary_dir/console-sentinel-trace.json"

python3 - "$temporary_dir/console-summary.json" "$temporary_dir/console-model-calls.json" \
  "$temporary_dir/console-mcp-calls.json" "$temporary_dir/console-sentinel-trace.json" \
  "$SENTINEL" "$started_epoch_ms" >"$temporary_dir/canonical-trace-ids" <<'PY'
import json, sys
summary, models, mcps, detail = [json.load(open(path, encoding="utf-8")) for path in sys.argv[1:5]]
sentinel = sys.argv[5]
started = int(sys.argv[6])
serialized = json.dumps([summary, models, mcps, detail], ensure_ascii=False)
if sentinel in serialized or "events" in detail or "attributes" in detail:
    raise SystemExit("Console API leaked a forbidden raw field or sentinel")
if summary.get("sources", {}).get("metrics") not in {"healthy", "partial"}:
    raise SystemExit("Console metrics API is offline")
recent_models = [item for item in models.get("items", []) if item.get("source") == "ai-base-llm-gateway" and int(__import__("datetime").datetime.fromisoformat(item["startedAt"].replace("Z", "+00:00")).timestamp() * 1000) >= started]
recent_public_mcp = [item for item in mcps.get("items", []) if item.get("source") == "ai-base-mcp-access-gateway" and int(__import__("datetime").datetime.fromisoformat(item["startedAt"].replace("Z", "+00:00")).timestamp() * 1000) >= started]
recent_internal_mcp = [item for item in mcps.get("items", []) if item.get("source") == "ai-base-llm-gateway" and int(__import__("datetime").datetime.fromisoformat(item["startedAt"].replace("Z", "+00:00")).timestamp() * 1000) >= started]
if not recent_models or not recent_public_mcp or not recent_internal_mcp:
    raise SystemExit("Console diagnostic API did not return all three canonical fixtures")
for item in recent_models:
    print(f"model\t{item['traceId']}")
print(f"mcp\t{recent_public_mcp[0]['traceId']}")
PY

mcp_trace_id="$(awk -F '\t' '$1 == "mcp" { print $2; exit }' "$temporary_dir/canonical-trace-ids")"
model_trace_id=""
while IFS=$'\t' read -r kind candidate; do
  [[ "$kind" == "model" ]] || continue
  wait_for_trace "$candidate" "$temporary_dir/model-trace-candidate.json"
  if grep -Fq 'external_gateway' "$temporary_dir/model-trace-candidate.json"; then
    model_trace_id="$candidate"
    cp "$temporary_dir/model-trace-candidate.json" "$temporary_dir/model-trace.json"
    break
  fi
done <"$temporary_dir/canonical-trace-ids"
[[ -n "$model_trace_id" ]] || {
  printf 'FAIL: Console model diagnostics did not contain the public carrier fixture\n' >&2
  exit 1
}
wait_for_trace "$mcp_trace_id" "$temporary_dir/mcp-trace.json"

python3 - "$temporary_dir/model-trace.json" "$temporary_dir/mcp-trace.json" "$SENTINEL" "$FORGED_TRACE_ID" <<'PY'
import json, sys

def attrs(payload):
    result = {}
    for resource_spans in payload.get("result", {}).get("resourceSpans", []):
        for scope_spans in resource_spans.get("scopeSpans", []):
            for span in scope_spans.get("spans", []):
                for item in span.get("attributes", []):
                    value = item.get("value", {})
                    result[item.get("key")] = next(iter(value.values()), None)
    return result

model = json.load(open(sys.argv[1], encoding="utf-8"))
mcp = json.load(open(sys.argv[2], encoding="utf-8"))
for payload in (model, mcp):
    serialized = json.dumps(payload, ensure_ascii=False)
    if sys.argv[3] in serialized or sys.argv[4] in serialized:
        raise SystemExit("carrier or sentinel survived in a gateway trace")
if attrs(model).get("traffic.origin") != "external_gateway":
    raise SystemExit("public model request did not receive a sealed external origin")
mcp_attrs = attrs(mcp)
if mcp_attrs.get("traffic.origin") != "public_mcp_gateway" or mcp_attrs.get("mcp.external_context_received") is not False:
    raise SystemExit("edge-scrubbed MCP request did not prove a server-owned root")
PY

internal_get 'http://prometheus:9090/api/v1/query?query=%7B__name__%3D~%22gen_ai_.*%7Cmcp_.*%22%7D' >"$temporary_dir/prometheus-observability.json"
if grep -Fq "$SENTINEL" "$temporary_dir/prometheus-observability.json"; then
  printf 'FAIL: sensitive sentinel survived in Prometheus labels\n' >&2
  exit 1
fi

docker compose logs --no-color --since "$started_at" >"$temporary_dir/compose.log"
if grep -Fq "$SENTINEL" "$temporary_dir/compose.log"; then
  printf 'FAIL: sensitive sentinel survived in ordinary service logs\n' >&2
  exit 1
fi

docker compose restart jaeger >/dev/null
jaeger_container="$(docker compose ps -q jaeger)"
deadline=$((SECONDS + 60))
while [[ "$(docker inspect --format '{{if .State.Health}}{{.State.Health.Status}}{{else}}{{.State.Status}}{{end}}' "$jaeger_container")" != "healthy" ]]; do
  if ((SECONDS >= deadline)); then
    printf 'FAIL: Jaeger did not become healthy after restart\n' >&2
    exit 1
  fi
  sleep 2
done
wait_for_trace "$sentinel_trace_id" "$temporary_dir/sentinel-trace-after-restart.json"

printf 'PASS: live model/MCP carriers created platform-owned roots\n'
printf 'PASS: management model traffic is separately labeled and excluded by Console PromQL\n'
printf 'PASS: internal Envoy MCP contributes to the MCP-only SpanMetrics pipeline\n'
printf 'PASS: sentinel absent from Jaeger, Prometheus, Console APIs, and ordinary logs\n'
printf 'PASS: Badger retained trace %s across Jaeger restart\n' "$sentinel_trace_id"
