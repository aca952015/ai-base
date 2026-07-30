ARG LIGHTRAG_IMAGE=ghcr.io/hkuds/lightrag:v1.4.16

FROM ${LIGHTRAG_IMAGE}

COPY deploy/lightrag/supervisor.py /app/ai-base/supervisor.py

ENTRYPOINT ["python", "/app/ai-base/supervisor.py"]
