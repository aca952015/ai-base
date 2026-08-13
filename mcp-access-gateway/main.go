package main

import (
	"context"
	"log/slog"
	"net/http"
	"os"
	"time"
)

func main() {
	cfg, err := loadConfig()
	if err != nil {
		slog.Error("invalid configuration", "error", err)
		os.Exit(1)
	}

	login, err := newDexLoginProvider(context.Background(), cfg)
	if err != nil {
		slog.Error("login OIDC provider unavailable", "error", err)
		os.Exit(1)
	}
	broker, err := newOAuthBroker(cfg, login)
	if err != nil {
		slog.Error("OAuth broker initialization failed", "error", err)
		os.Exit(1)
	}
	gateway := newMCPGateway(cfg, newOIDCTokenVerifier(cfg))
	defer func() {
		shutdownCtx, cancel := context.WithTimeout(context.Background(), 5*time.Second)
		defer cancel()
		if err := gateway.observe.shutdown(shutdownCtx); err != nil {
			slog.Warn("OpenTelemetry shutdown incomplete", "error", err)
		}
	}()
	server := &http.Server{
		Addr:              cfg.listenAddress,
		Handler:           applicationRoutes(gateway, broker),
		ReadHeaderTimeout: 10 * time.Second,
		ReadTimeout:       30 * time.Second,
		IdleTimeout:       2 * time.Minute,
		MaxHeaderBytes:    64 << 10,
	}

	slog.Info(
		"starting MCP access gateway",
		"address", cfg.listenAddress,
		"resource", cfg.resourceURL,
		"issuer", cfg.issuer,
		"login_issuer", cfg.loginIssuer,
	)
	if err := server.ListenAndServe(); err != nil && err != http.ErrServerClosed {
		slog.Error("MCP access gateway stopped", "error", err)
		os.Exit(1)
	}
}
