#!/usr/bin/env bash
set -euo pipefail

root="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
probe="$root/scripts/observability-probe.sh"
temporary_dir="$(mktemp -d "${TMPDIR:-/tmp}/ai-base-observability-test.XXXXXX")"
trap 'rm -rf "$temporary_dir"' EXIT

"$probe" >"$temporary_dir/default.out"
grep -Fq 'PASS: length-prefixed HMAC fixtures' "$temporary_dir/default.out"
grep -Fq 'SKIP: live image' "$temporary_dir/default.out"

cat >"$temporary_dir/metrics.prom" <<'EOF'
# HELP gen_ai_client_token_usage Number of tokens processed.
# TYPE gen_ai_client_token_usage histogram
gen_ai_client_token_usage_bucket{gen_ai_operation_name="chat",gen_ai_original_model="safe",gen_ai_provider_name="openai",gen_ai_request_model="upstream",gen_ai_response_model="upstream",gen_ai_token_type="input",otel_scope_name="envoyproxy/ai-gateway",otel_scope_schema_url="",otel_scope_version="",traffic_origin="external_gateway",le="16"} 1
gen_ai_client_token_usage_sum{gen_ai_operation_name="chat",gen_ai_original_model="safe",gen_ai_provider_name="openai",gen_ai_request_model="upstream",gen_ai_response_model="upstream",gen_ai_token_type="input",otel_scope_name="envoyproxy/ai-gateway",otel_scope_schema_url="",otel_scope_version="",traffic_origin="external_gateway"} 7
gen_ai_client_token_usage_count{gen_ai_operation_name="chat",gen_ai_original_model="safe",gen_ai_provider_name="openai",gen_ai_request_model="upstream",gen_ai_response_model="upstream",gen_ai_token_type="input",otel_scope_name="envoyproxy/ai-gateway",otel_scope_schema_url="",otel_scope_version="",traffic_origin="external_gateway"} 1
# HELP gen_ai_server_request_duration_seconds Request duration.
# TYPE gen_ai_server_request_duration_seconds histogram
gen_ai_server_request_duration_seconds_bucket{gen_ai_operation_name="chat",gen_ai_original_model="safe",gen_ai_provider_name="openai",gen_ai_request_model="upstream",gen_ai_response_model="upstream",otel_scope_name="envoyproxy/ai-gateway",otel_scope_schema_url="",otel_scope_version="",traffic_origin="external_gateway",le="1"} 1
gen_ai_server_request_duration_seconds_sum{gen_ai_operation_name="chat",gen_ai_original_model="safe",gen_ai_provider_name="openai",gen_ai_request_model="upstream",gen_ai_response_model="upstream",otel_scope_name="envoyproxy/ai-gateway",otel_scope_schema_url="",otel_scope_version="",traffic_origin="external_gateway"} 0.2
gen_ai_server_request_duration_seconds_count{gen_ai_operation_name="chat",gen_ai_original_model="safe",gen_ai_provider_name="openai",gen_ai_request_model="upstream",gen_ai_response_model="upstream",otel_scope_name="envoyproxy/ai-gateway",otel_scope_schema_url="",otel_scope_version="",traffic_origin="external_gateway"} 1
EOF

"$probe" --check-metrics "$temporary_dir/metrics.prom" >"$temporary_dir/metrics.out"
grep -Fq 'PASS: canonical metric/label inventory' "$temporary_dir/metrics.out"

sed 's/le="1"/le="1",trace_id="forbidden"/' "$temporary_dir/metrics.prom" >"$temporary_dir/bad.prom"
if "$probe" --check-metrics "$temporary_dir/bad.prom" >"$temporary_dir/bad.out" 2>&1; then
  printf 'expected forbidden metric label to fail\n' >&2
  exit 1
fi
grep -Fq 'forbidden/unclassified labels' "$temporary_dir/bad.out"

cp "$temporary_dir/metrics.prom" "$temporary_dir/series-after.prom"
"$probe" --check-series "$temporary_dir/metrics.prom" "$temporary_dir/series-after.prom" \
  >"$temporary_dir/series.out"
grep -Fq 'canonical series delta 0/10' "$temporary_dir/series.out"
for index in $(seq 1 11); do
  printf 'gen_ai_server_request_duration_seconds_count{gen_ai_original_model="unknown-%s"} 1\n' "$index" \
    >>"$temporary_dir/series-after.prom"
done
if "$probe" --check-series "$temporary_dir/metrics.prom" "$temporary_dir/series-after.prom" \
  >"$temporary_dir/series-bad.out" 2>&1; then
  printf 'expected unknown-model series budget to fail\n' >&2
  exit 1
fi
grep -Fq '1,000 unknown models added 11 canonical series' "$temporary_dir/series-bad.out"

printf 'service.name\nservice.version\n' >"$temporary_dir/attributes.txt"
"$probe" --check-attributes "$temporary_dir/attributes.txt" --sentinel AI_BASE_SENTINEL \
  >"$temporary_dir/attributes.out"
printf 'input.value=AI_BASE_SENTINEL\n' >>"$temporary_dir/attributes.txt"
if "$probe" --check-attributes "$temporary_dir/attributes.txt" --sentinel AI_BASE_SENTINEL \
  >"$temporary_dir/attributes-bad.out" 2>&1; then
  printf 'expected sentinel inventory to fail\n' >&2
  exit 1
fi
grep -Fq 'sensitive sentinel is present' "$temporary_dir/attributes-bad.out"

"$probe" --list-carriers | while IFS= read -r carrier; do
  printf '%s\tscrubbed\tnew_root\tsampled\n' "$carrier"
done >"$temporary_dir/carriers.tsv"
"$probe" --check-carriers "$temporary_dir/carriers.tsv" >"$temporary_dir/carriers.out"
grep -Fq 'carrier scrub contract' "$temporary_dir/carriers.out"
sed '$d' "$temporary_dir/carriers.tsv" >"$temporary_dir/carriers-bad.tsv"
if "$probe" --check-carriers "$temporary_dir/carriers-bad.tsv" \
  >"$temporary_dir/carriers-bad.out" 2>&1; then
  printf 'expected incomplete carrier result inventory to fail\n' >&2
  exit 1
fi
grep -Fq 'carrier did not prove' "$temporary_dir/carriers-bad.out"

if "$probe" --live >"$temporary_dir/live.out" 2>&1; then
  printf 'expected incomplete live invocation to fail\n' >&2
  exit 1
fi
grep -Fq -- '--live requires --metrics-url' "$temporary_dir/live.out"

printf 'PASS: observability probe tests\n'
