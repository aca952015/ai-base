FROM golang:1.26.5-alpine AS build

WORKDIR /src
COPY go.mod ./
COPY . .
RUN CGO_ENABLED=0 go build -trimpath -ldflags="-s -w" -o /out/wecom-auth-bridge .

FROM alpine:3.22
RUN apk add --no-cache ca-certificates \
    && mkdir -p /data \
    && chown 65532:65532 /data
COPY --from=build /out/wecom-auth-bridge /usr/local/bin/wecom-auth-bridge
USER 65532:65532
VOLUME ["/data"]
EXPOSE 8082
ENTRYPOINT ["/usr/local/bin/wecom-auth-bridge"]
