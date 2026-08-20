package main

import (
	"errors"
	"log/slog"
	"net/http"
	"os"
	"strings"
	"time"
)

type config struct {
	listenAddress string
	serversPath   string
	secretsPath   string
	signingKey    []byte
}

func loadConfig() (config, error) {
	signingKey := []byte(firstNonEmpty(
		os.Getenv("MCP_BACKEND_ADAPTER_SIGNING_KEY"),
		os.Getenv("MCP_SESSION_SIGNING_KEY"),
		"local-mcp-session-signing-key-change-me",
	))
	if len(signingKey) < 32 {
		return config{}, errors.New("MCP_BACKEND_ADAPTER_SIGNING_KEY must contain at least 32 bytes")
	}
	return config{
		listenAddress: envOrDefault("MCP_BACKEND_ADAPTER_LISTEN_ADDRESS", ":8090"),
		serversPath:   envOrDefault("MCP_BACKEND_ADAPTER_SERVERS_PATH", "/control/llm-gateway-mcp-servers.json"),
		secretsPath:   envOrDefault("MCP_BACKEND_ADAPTER_SECRETS_PATH", "/control/llm-gateway-mcp-secrets"),
		signingKey:    signingKey,
	}, nil
}

func main() {
	cfg, err := loadConfig()
	if err != nil {
		slog.Error("invalid configuration", "error", err)
		os.Exit(1)
	}
	adapter := newMCPBackendAdapter(cfg)
	server := &http.Server{
		Addr:              cfg.listenAddress,
		Handler:           adapter.routes(),
		ReadHeaderTimeout: 10 * time.Second,
		ReadTimeout:       30 * time.Second,
		IdleTimeout:       2 * time.Minute,
		MaxHeaderBytes:    64 << 10,
	}
	slog.Info("starting MCP backend adapter", "address", cfg.listenAddress)
	if err := server.ListenAndServe(); err != nil && err != http.ErrServerClosed {
		slog.Error("MCP backend adapter stopped", "error", err)
		os.Exit(1)
	}
}

func envOrDefault(name, fallback string) string {
	if value, ok := os.LookupEnv(name); ok {
		return value
	}
	return fallback
}

func firstNonEmpty(values ...string) string {
	for _, value := range values {
		if value = strings.TrimSpace(value); value != "" {
			return value
		}
	}
	return ""
}
