#!/bin/sh
set -eu

config_path="${LLM_GATEWAY_CONFIG_PATH:-/control/llm-gateway-config.yaml}"
revision_path="${LLM_GATEWAY_REVISION_PATH:-/control/llm-gateway-revision}"
poll_seconds="${LLM_GATEWAY_RELOAD_INTERVAL:-2}"
child_pid=""

read_revision() {
  if [ -f "$revision_path" ]; then
    sed -n '1p' "$revision_path"
  else
    printf 'bootstrap\n'
  fi
}

start_gateway() {
  if [ -s "$config_path" ]; then
    /app run "$config_path" &
  elif [ -n "${OPEN_CONNECTOR_RUNTIME_TOKEN:-}" ]; then
    /app run --mcp-config /etc/ai-base/open-connector-mcp.json &
  else
    OPENAI_API_KEY="${OPENAI_API_KEY:-not-configured}" /app run &
  fi
  child_pid="$!"
}

stop_gateway() {
  if [ -n "$child_pid" ] && kill -0 "$child_pid" 2>/dev/null; then
    kill "$child_pid" 2>/dev/null || true
    wait "$child_pid" 2>/dev/null || true
  fi
}

trap 'stop_gateway; exit 0' INT TERM

current_revision="$(read_revision)"
start_gateway

while true; do
  sleep "$poll_seconds" &
  wait "$!"

  next_revision="$(read_revision)"
  if [ "$next_revision" != "$current_revision" ]; then
    stop_gateway
    current_revision="$next_revision"
    start_gateway
    continue
  fi

  if ! kill -0 "$child_pid" 2>/dev/null; then
    wait "$child_pid" 2>/dev/null || true
    start_gateway
  fi
done
