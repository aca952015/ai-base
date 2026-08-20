FROM golang:1.26.5-alpine AS build

WORKDIR /src
COPY go.mod ./
COPY . .
RUN CGO_ENABLED=0 go build -trimpath -ldflags="-s -w" -o /out/mcp-backend-adapter .

FROM alpine:3.22
RUN apk add --no-cache ca-certificates \
    && addgroup -S -g 1001 adapter \
    && adduser -S -D -H -u 1001 -G adapter adapter
COPY --from=build /out/mcp-backend-adapter /usr/local/bin/mcp-backend-adapter
USER 1001:1001
EXPOSE 8090
ENTRYPOINT ["/usr/local/bin/mcp-backend-adapter"]
