#!/usr/bin/env bash
set -euo pipefail

readonly CONTRACT_VERSION="ai-base-observability-v1"
readonly PINNED_IMAGE="envoyproxy/ai-gateway-cli:v1.0.0"
readonly PINNED_COLLECTOR_IMAGE="otel/opentelemetry-collector-contrib:0.135.0"
readonly PRINCIPAL_DOMAIN="ai-base-observability-principal:v1"
readonly FIXTURE_KEY_HEX="000102030405060708090a0b0c0d0e0f101112131415161718191a1b1c1d1e1f"
readonly FIXTURE_AB_C="7402309d2d8c4bf12a1e78815b51caf5"
readonly FIXTURE_A_BC="43f992c377fe8dbc03afbac4fbf95306"
readonly FAMILY_SERIES_BUDGET=5000
readonly TOTAL_SERIES_BUDGET=20000
readonly UNKNOWN_MODEL_SERIES_DELTA_BUDGET=10

readonly -a REQUIRED_IMAGE_ENV=(
  OTEL_EXPORTER_OTLP_ENDPOINT
  OTEL_EXPORTER_OTLP_TRACES_ENDPOINT
  OTEL_EXPORTER_OTLP_METRICS_ENDPOINT
  OTEL_PROPAGATORS
  OTEL_TRACES_SAMPLER
  OPENINFERENCE_HIDE_INPUTS
  OPENINFERENCE_HIDE_OUTPUTS
  OPENINFERENCE_HIDE_EMBEDDINGS_TEXT
  OPENINFERENCE_HIDE_EMBEDDINGS_VECTORS
)

readonly -a REQUIRED_METRIC_FAMILIES=(
  gen_ai_client_token_usage
  gen_ai_server_request_duration_seconds
)

readonly -a ALLOWED_MODEL_LABELS=(
  gen_ai_operation_name
  gen_ai_original_model
  gen_ai_provider_name
  gen_ai_request_model
  gen_ai_response_model
  gen_ai_token_type
  traffic_origin
  otel_scope_name
  otel_scope_schema_url
  otel_scope_version
  le
)

readonly -a SCRUBBED_CARRIERS=(
  traceparent tracestate baggage b3
  x-b3-traceid x-b3-spanid x-b3-parentspanid x-b3-sampled x-b3-flags
  uber-trace-id x-ot-span-context
  ot-tracer-traceid ot-tracer-spanid ot-tracer-sampled
  grpc-trace-bin x-cloud-trace-context x-goog-cloud-trace-context x-amzn-trace-id
  x-request-id x-client-trace-id x-envoy-force-trace
  agent-session-id x-session-id session-id
  x-user-id x-auth-request-user x-auth-request-email x-forwarded-user
)

readonly -a FORBIDDEN_ATTRIBUTE_KEYS=(
  gen_ai.input.messages
  gen_ai.output.messages
  gen_ai.system_instructions
  gen_ai.tool.definitions
  gen_ai.tool.call.arguments
  gen_ai.tool.call.result
  gen_ai.retrieval.query.text
  llm.input_messages.*
  llm.output_messages.*
  llm.prompts
  llm.choices
  embedding.*
)

usage() {
  cat <<'EOF'
Usage:
  scripts/observability-probe.sh
  scripts/observability-probe.sh --check-metrics FILE
  scripts/observability-probe.sh --check-series BASELINE AFTER
  scripts/observability-probe.sh --check-attributes FILE --sentinel VALUE
  scripts/observability-probe.sh --check-carriers FILE
  scripts/observability-probe.sh --live --metrics-url URL \
    --attributes-file FILE --sentinel VALUE --carriers-file FILE \
    --series-baseline FILE --series-after FILE

Default mode is read-only and validates the repository contract and HMAC fixtures.
It intentionally does not start containers, send traffic, or query a live gateway.

--live performs the image and running-gateway gates. It is intended only for an
isolated probe gateway: the caller must supply captured before/after metric files
for the 1,000-unknown-model test and a raw span-attribute inventory.
EOF
}

fail() {
  printf 'FAIL: %s\n' "$*" >&2
  return 1
}

pass() {
  printf 'PASS: %s\n' "$*"
}

require_command() {
  command -v "$1" >/dev/null 2>&1 || fail "required command not found: $1"
}

repo_root() {
  cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd
}

verify_repository_contract() {
  local root dockerfile schema caddy
  root="$(repo_root)"
  dockerfile="$root/deploy/llm-gateway/Dockerfile"
  schema="$root/docs/observability-schema.md"
  caddy="$root/deploy/global-gateway/Caddyfile"

  grep -Fqx "FROM ${PINNED_IMAGE} AS upstream" "$dockerfile" \
    || fail "llm gateway image is not pinned to ${PINNED_IMAGE}"
  grep -Fq "Contract version: \`${CONTRACT_VERSION}\`" "$schema" \
    || fail "schema contract version is missing or mismatched"

  local value
  for value in "${REQUIRED_IMAGE_ENV[@]}" "${REQUIRED_METRIC_FAMILIES[@]}" \
    "${ALLOWED_MODEL_LABELS[@]}" "${SCRUBBED_CARRIERS[@]}" \
    "${FORBIDDEN_ATTRIBUTE_KEYS[@]}"; do
    grep -Fq "\`${value}\`" "$schema" || fail "schema does not contain ${value}"
  done
  for value in "${SCRUBBED_CARRIERS[@]}"; do
    grep -Fq "header_up -${value}" "$caddy" \
      || fail "public gateway does not scrub ${value}"
  done
  grep -Fq 'header_up X-AI-Base-Traffic-Origin external_gateway' "$caddy" \
    || fail "public model gateway does not seal traffic origin"
  grep -Fq 'OTEL_AIGW_SPAN_REQUEST_HEADER_ATTRIBUTES: "x-ai-base-traffic-origin:traffic.origin"' "$root/compose.yaml" \
    || fail "AI Gateway does not map the sealed origin into traffic.origin"
  grep -Fq 'OTEL_AIGW_METRICS_REQUEST_HEADER_ATTRIBUTES: "x-ai-base-traffic-origin:traffic.origin"' "$root/compose.yaml" \
    || fail "AI Gateway model metrics do not include the sealed traffic origin"
  grep -Fq "image: ${PINNED_COLLECTOR_IMAGE}" "$root/compose.yaml" \
    || fail "OpenTelemetry Collector is not pinned to ${PINNED_COLLECTOR_IMAGE}"
  grep -Fq 'filter/drop-span-events' "$root/deploy/otel-collector/collector.yaml" \
    || fail "OpenTelemetry Collector does not drop span events"
  grep -Fq 'set(span.status.message, "")' "$root/deploy/otel-collector/collector.yaml" \
    || fail "OpenTelemetry Collector does not clear span status messages"
  pass "repository contract and ${PINNED_IMAGE} pin"
}

verify_hmac_fixtures() {
  require_command python3
  python3 - "$PRINCIPAL_DOMAIN" "$FIXTURE_KEY_HEX" "$FIXTURE_AB_C" "$FIXTURE_A_BC" <<'PY'
import hashlib
import hmac
import struct
import sys

domain, key_hex, expected_one, expected_two = sys.argv[1:]
key = bytes.fromhex(key_hex)

def fingerprint(issuer: str, subject: str) -> str:
    issuer_bytes = issuer.encode("utf-8")
    subject_bytes = subject.encode("utf-8")
    message = (
        domain.encode("ascii")
        + struct.pack(">I", len(issuer_bytes))
        + issuer_bytes
        + struct.pack(">I", len(subject_bytes))
        + subject_bytes
    )
    return hmac.new(key, message, hashlib.sha256).digest()[:16].hex()

actual_one = fingerprint("ab", "c")
actual_two = fingerprint("a", "bc")
if actual_one != expected_one or actual_two != expected_two:
    raise SystemExit(
        f"fixture mismatch: ('ab','c')={actual_one}, ('a','bc')={actual_two}"
    )
if actual_one == actual_two:
    raise SystemExit("length-prefixed fixtures collided")
PY
  pass "length-prefixed HMAC fixtures"
}

verify_image_capabilities() {
  require_command docker
  require_command tar
  local temporary_dir container_id binary_path env_name
  temporary_dir="$(mktemp -d "${TMPDIR:-/tmp}/ai-base-observability-probe.XXXXXX")"
  container_id=""
  cleanup_image_probe() {
    if [[ -n "$container_id" ]]; then
      docker rm "$container_id" >/dev/null 2>&1 || true
    fi
    rm -rf "$temporary_dir"
  }
  trap cleanup_image_probe RETURN

  docker image inspect "$PINNED_IMAGE" >/dev/null 2>&1 \
    || fail "pinned image is not locally available: ${PINNED_IMAGE}"
  container_id="$(docker create "$PINNED_IMAGE")"
  binary_path="$temporary_dir/aigw"
  docker cp "$container_id:/app" - | tar -xOf - >"$binary_path"

  for env_name in "${REQUIRED_IMAGE_ENV[@]}"; do
    grep -aFq "$env_name" "$binary_path" \
      || fail "${PINNED_IMAGE} does not prove support for ${env_name}"
  done
  pass "pinned image OTEL/OpenInference environment capability"
}

verify_metrics_file() {
  local metrics_file="$1"
  [[ -s "$metrics_file" ]] || fail "metrics inventory is missing or empty: $metrics_file"
  require_command python3
  python3 - "$metrics_file" "$FAMILY_SERIES_BUDGET" "$TOTAL_SERIES_BUDGET" \
    "${REQUIRED_METRIC_FAMILIES[*]}" "${ALLOWED_MODEL_LABELS[*]}" <<'PY'
import re
import sys
from collections import Counter

path, family_budget, total_budget, families_arg, labels_arg = sys.argv[1:]
family_budget = int(family_budget)
total_budget = int(total_budget)
required = set(families_arg.split())
allowed_labels = set(labels_arg.split())
common_labels = {
    "gen_ai_operation_name",
    "gen_ai_original_model",
    "gen_ai_provider_name",
    "gen_ai_request_model",
    "gen_ai_response_model",
    "otel_scope_name",
    "otel_scope_schema_url",
    "otel_scope_version",
    "traffic_origin",
    "le",
}
expected_labels = {
    "gen_ai_client_token_usage": common_labels | {"gen_ai_token_type"},
    "gen_ai_server_request_duration_seconds": common_labels,
}
types = {}
series = Counter()
labels_by_family = {}
line_re = re.compile(r'^([a-zA-Z_:][a-zA-Z0-9_:]*)(?:\{([^}]*)\})?\s+')
label_re = re.compile(r'(\w+)="(?:[^"\\]|\\.)*"')

with open(path, encoding="utf-8") as handle:
    for raw in handle:
        line = raw.strip()
        if line.startswith("# TYPE "):
            _, _, name, metric_type = line.split(None, 3)
            types[name] = metric_type
            continue
        if not line or line.startswith("#"):
            continue
        match = line_re.match(line)
        if not match:
            raise SystemExit(f"invalid Prometheus exposition line: {line[:120]}")
        sample, raw_labels = match.groups()
        family = sample
        for suffix in ("_bucket", "_sum", "_count", "_created"):
            if family.endswith(suffix):
                family = family[:-len(suffix)]
                break
        if family not in required:
            if family.startswith("gen_ai_"):
                raise SystemExit(f"unclassified model metric family: {family}")
            continue
        labels = set(label_re.findall(raw_labels or ""))
        unexpected = labels - allowed_labels
        if unexpected:
            raise SystemExit(f"{family}: forbidden/unclassified labels: {sorted(unexpected)}")
        labels_by_family.setdefault(family, set()).update(labels)
        series[family] += 1

missing = required - set(types)
if missing:
    raise SystemExit(f"missing canonical metric families: {sorted(missing)}")
for family in required:
    if types.get(family) != "histogram":
        raise SystemExit(f"{family}: expected histogram, got {types.get(family)!r}")
    if labels_by_family.get(family, set()) != expected_labels[family]:
        raise SystemExit(
            f"{family}: label inventory mismatch; expected "
            f"{sorted(expected_labels[family])}, got "
            f"{sorted(labels_by_family.get(family, set()))}"
        )
    if series[family] > family_budget:
        raise SystemExit(f"{family}: {series[family]} series exceeds {family_budget}")
if sum(series.values()) > total_budget:
    raise SystemExit(f"canonical total {sum(series.values())} exceeds {total_budget}")

for family in sorted(required):
    print(f"INVENTORY: {family} type={types[family]} series={series[family]} labels={','.join(sorted(labels_by_family.get(family, set())))}")
PY
  pass "canonical metric/label inventory and active-series budgets"
}

verify_series_delta() {
  local baseline="$1" after="$2"
  [[ -s "$baseline" ]] || fail "series baseline is missing or empty: $baseline"
  [[ -s "$after" ]] || fail "series after-snapshot is missing or empty: $after"
  python3 - "$baseline" "$after" "$UNKNOWN_MODEL_SERIES_DELTA_BUDGET" <<'PY'
import re
import sys

families = {"gen_ai_client_token_usage", "gen_ai_server_request_duration_seconds"}
budget = int(sys.argv[3])

def identities(path: str) -> set[str]:
    result = set()
    with open(path, encoding="utf-8") as handle:
        for line in handle:
            if not line or line.startswith("#"):
                continue
            match = re.match(r'^([a-zA-Z_:][a-zA-Z0-9_:]*)(?:\{([^}]*)\})?', line)
            if not match:
                continue
            sample, labels = match.groups()
            family = sample
            for suffix in ("_bucket", "_sum", "_count", "_created"):
                if family.endswith(suffix):
                    family = family[:-len(suffix)]
                    break
            if family in families:
                result.add(f"{sample}{{{labels or ''}}}")
    return result

before = identities(sys.argv[1])
after = identities(sys.argv[2])
missing = before - after
if missing:
    raise SystemExit(
        f"{len(missing)} baseline series disappeared; snapshots are not comparable"
    )
delta = len(after - before)
if delta > budget:
    raise SystemExit(
        f"1,000 unknown models added {delta} canonical series (budget {budget})"
    )
print(f"PASS: unknown-model canonical series delta {delta}/{budget}")
PY
}

verify_attribute_inventory() {
  local attributes_file="$1" sentinel="$2"
  [[ -s "$attributes_file" ]] || fail "span attribute inventory is missing or empty: $attributes_file"
  [[ -n "$sentinel" ]] || fail "sentinel must be non-empty"
  if grep -Fq "$sentinel" "$attributes_file"; then
    fail "sensitive sentinel is present in span attribute inventory"
  fi

  local forbidden_regex
  forbidden_regex='(^|[.])(authorization|cookie|set_cookie|body|query|url|uri|token|secret|password|prompt|completion|messages?|instructions?|tool_call_arguments|tool_call_result)([.]|$)'
  if grep -Eiq "$forbidden_regex" "$attributes_file"; then
    fail "span inventory contains a forbidden or unclassified content-bearing attribute"
  fi
  pass "span red-line inventory and sentinel absence"
}

verify_carrier_results() {
  local carriers_file="$1" carrier
  [[ -s "$carriers_file" ]] || fail "carrier result inventory is missing or empty: $carriers_file"
  for carrier in "${SCRUBBED_CARRIERS[@]}"; do
    grep -Fqx "${carrier}"$'\t''scrubbed'$'\t''new_root'$'\t''sampled' "$carriers_file" \
      || fail "carrier did not prove scrubbed/new-root/100%-sampled: $carrier"
  done
  if ! awk -F '\t' 'NF != 4 || $1 !~ /^[a-z0-9._-]+$/ || $2 != "scrubbed" || $3 != "new_root" || $4 != "sampled" { exit 1 }' "$carriers_file"; then
    fail "carrier result inventory contains malformed or non-passing rows"
  fi
  pass "external propagation, request-ID, force/debug, session, and identity carrier scrub contract"
}

mode="contract"
metrics_url=""
metrics_file=""
attributes_file=""
carriers_file=""
sentinel=""
series_baseline=""
series_after=""

while (($#)); do
  case "$1" in
    --live) mode="live"; shift ;;
    --check-metrics) mode="check-metrics"; metrics_file="${2:-}"; shift 2 ;;
    --check-series)
      mode="check-series"
      series_baseline="${2:-}"
      series_after="${3:-}"
      shift 3
      ;;
    --check-attributes) mode="check-attributes"; attributes_file="${2:-}"; shift 2 ;;
    --check-carriers) mode="check-carriers"; carriers_file="${2:-}"; shift 2 ;;
    --list-carriers)
      printf '%s\n' "${SCRUBBED_CARRIERS[@]}"
      exit 0
      ;;
    --metrics-url) metrics_url="${2:-}"; shift 2 ;;
    --attributes-file) attributes_file="${2:-}"; shift 2 ;;
    --carriers-file) carriers_file="${2:-}"; shift 2 ;;
    --sentinel) sentinel="${2:-}"; shift 2 ;;
    --series-baseline) series_baseline="${2:-}"; shift 2 ;;
    --series-after) series_after="${2:-}"; shift 2 ;;
    -h|--help) usage; exit 0 ;;
    *) usage >&2; fail "unknown argument: $1"; exit 2 ;;
  esac
done

verify_repository_contract
verify_hmac_fixtures

case "$mode" in
  contract)
    printf 'SKIP: live image, gateway metrics, carrier/sentinel, and unknown-model probes require explicit --live.\n'
    ;;
  check-metrics)
    verify_metrics_file "$metrics_file"
    ;;
  check-series)
    verify_series_delta "$series_baseline" "$series_after"
    ;;
  check-attributes)
    verify_attribute_inventory "$attributes_file" "$sentinel"
    ;;
  check-carriers)
    verify_carrier_results "$carriers_file"
    ;;
  live)
    [[ -n "$metrics_url" ]] || fail "--live requires --metrics-url"
    [[ "$metrics_url" =~ ^https?:// ]] || fail "--metrics-url must be an HTTP(S) running-gateway endpoint"
    [[ -n "$attributes_file" ]] || fail "--live requires --attributes-file"
    [[ -n "$carriers_file" ]] || fail "--live requires --carriers-file"
    [[ -n "$sentinel" ]] || fail "--live requires --sentinel"
    [[ -n "$series_baseline" ]] || fail "--live requires --series-baseline"
    [[ -n "$series_after" ]] || fail "--live requires --series-after"
    require_command curl
    temporary_metrics="$(mktemp "${TMPDIR:-/tmp}/ai-base-observability-metrics.XXXXXX")"
    trap 'rm -f "$temporary_metrics"' EXIT
    curl --fail --silent --show-error --max-time 10 "$metrics_url" >"$temporary_metrics"
    verify_image_capabilities
    verify_metrics_file "$temporary_metrics"
    verify_attribute_inventory "$attributes_file" "$sentinel"
    verify_carrier_results "$carriers_file"
    verify_metrics_file "$series_after"
    verify_series_delta "$series_baseline" "$series_after"
    pass "all live PR1 capability gates"
    ;;
esac
