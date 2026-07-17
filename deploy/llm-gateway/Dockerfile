FROM envoyproxy/ai-gateway-cli:v1.0.0 AS upstream

FROM debian:bookworm-slim

RUN apt-get update \
  && apt-get install -y --no-install-recommends ca-certificates curl tini \
  && rm -rf /var/lib/apt/lists/* \
  && groupadd --system --gid 1001 gateway \
  && useradd --system --uid 1001 --gid gateway --home-dir /home/gateway --create-home gateway

COPY --from=upstream /app /app
COPY --chmod=755 deploy/llm-gateway/entrypoint.sh /usr/local/bin/llm-gateway-entrypoint

ENV HOME=/home/gateway \
    SSL_CERT_FILE=/etc/ssl/certs/ca-certificates.crt \
    AIGW_RUN_ID=0 \
    AIGW_CONFIG_HOME=/home/gateway/.config/aigw \
    AIGW_DATA_HOME=/home/gateway/.local/share/aigw \
    AIGW_STATE_HOME=/home/gateway/.local/state/aigw \
    AIGW_RUNTIME_DIR=/tmp/aigw-1001

USER gateway
WORKDIR /home/gateway

EXPOSE 1975 1064
ENTRYPOINT ["/usr/bin/tini", "--", "/usr/local/bin/llm-gateway-entrypoint"]
