FROM golang:1.26.5-alpine AS build

WORKDIR /src
COPY go.mod go.sum ./
RUN go mod download
COPY . .
RUN CGO_ENABLED=0 go build -trimpath -ldflags="-s -w" -o /out/mcp-access-gateway .

FROM alpine:3.22
RUN apk add --no-cache ca-certificates \
    && mkdir -p /data \
    && chown 65532:65532 /data
COPY --from=build /out/mcp-access-gateway /usr/local/bin/mcp-access-gateway
USER 65532:65532
VOLUME ["/data"]
EXPOSE 8081
ENTRYPOINT ["/usr/local/bin/mcp-access-gateway"]
