package main

import (
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
	signingKey, err := loadOrCreateSigner(cfg.signingKeyPath)
	if err != nil {
		slog.Error("OIDC signing key unavailable", "error", err)
		os.Exit(1)
	}
	refreshTokens, err := loadRefreshStore(cfg.refreshStorePath, cfg.refreshTokenLifetime)
	if err != nil {
		slog.Error("refresh token store unavailable", "error", err)
		os.Exit(1)
	}
	httpClient := &http.Client{Timeout: 10 * time.Second}
	authConfiguration := &remoteAuthConfigurationProvider{
		url:    cfg.integrationConfigURL,
		token:  cfg.integrationConfigToken,
		client: httpClient,
	}
	wecom := &wecomClient{apiBase: cfg.apiBaseURL, client: httpClient}
	application := newProvider(cfg, authConfiguration, wecom, signingKey, refreshTokens)
	server := &http.Server{
		Addr:              cfg.listenAddress,
		Handler:           application.routes(),
		ReadHeaderTimeout: 10 * time.Second,
		ReadTimeout:       30 * time.Second,
		WriteTimeout:      30 * time.Second,
		IdleTimeout:       2 * time.Minute,
		MaxHeaderBytes:    32 << 10,
	}
	slog.Info(
		"starting WeCom auth bridge",
		"address", cfg.listenAddress,
		"issuer", cfg.issuer,
		"configuration_url", cfg.integrationConfigURL,
	)
	if err := server.ListenAndServe(); err != nil && err != http.ErrServerClosed {
		slog.Error("WeCom auth bridge stopped", "error", err)
		os.Exit(1)
	}
}
