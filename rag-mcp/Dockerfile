FROM python:3.13-alpine

RUN addgroup -S -g 1001 ragmcp \
  && adduser -S -u 1001 -G ragmcp ragmcp

WORKDIR /app
COPY --chown=ragmcp:ragmcp rag-mcp/server.py /app/server.py

USER ragmcp

EXPOSE 8080

ENTRYPOINT ["python", "/app/server.py"]
