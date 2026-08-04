package main

import (
	"errors"
	"os"
	"strings"
	"time"
)

type config struct {
	listenAddress          string
	issuer                 string
	clientID               string
	clientSecret           string
	dexRedirectURI         string
	integrationConfigURL   string
	integrationConfigToken string
	authorizationURL       string
	apiBaseURL             string
	signingKeyPath         string
	refreshStorePath       string
	accessTokenLifetime    time.Duration
	refreshTokenLifetime   time.Duration
	requestLifetime        time.Duration
}

func loadConfig() (config, error) {
	cfg := config{
		listenAddress:          envOr("WECOM_AUTH_LISTEN_ADDRESS", ":8082"),
		issuer:                 strings.TrimRight(envOr("WECOM_AUTH_ISSUER", "http://wecom-auth-bridge:8082"), "/"),
		clientID:               envOr("WECOM_OIDC_CLIENT_ID", "ai-base-dex"),
		clientSecret:           os.Getenv("WECOM_OIDC_CLIENT_SECRET"),
		dexRedirectURI:         envOr("WECOM_DEX_REDIRECT_URI", "http://dex.localtest.me:5556/dex/callback"),
		integrationConfigURL:   envOr("WECOM_INTEGRATION_CONFIG_URL", "http://ai-console:3000/api/internal/wecom-auth/config"),
		integrationConfigToken: os.Getenv("WECOM_AUTH_BRIDGE_CONFIG_TOKEN"),
		authorizationURL:       envOr("WECOM_AUTHORIZATION_URL", "https://open.weixin.qq.com/connect/oauth2/authorize"),
		apiBaseURL:             strings.TrimRight(envOr("WECOM_API_BASE_URL", "https://qyapi.weixin.qq.com"), "/"),
		signingKeyPath:         envOr("WECOM_OIDC_SIGNING_KEY_PATH", "/data/signing-key.pem"),
		refreshStorePath:       envOr("WECOM_OIDC_REFRESH_STORE_PATH", "/data/refresh-grants.json"),
		accessTokenLifetime:    durationOr("WECOM_OIDC_ACCESS_TOKEN_LIFETIME", time.Hour),
		refreshTokenLifetime:   durationOr("WECOM_OIDC_REFRESH_TOKEN_LIFETIME", 90*24*time.Hour),
		requestLifetime:        durationOr("WECOM_OIDC_REQUEST_LIFETIME", 10*time.Minute),
	}
	for label, value := range map[string]string{
		"WECOM_AUTH_ISSUER":              cfg.issuer,
		"WECOM_OIDC_CLIENT_ID":           cfg.clientID,
		"WECOM_OIDC_CLIENT_SECRET":       cfg.clientSecret,
		"WECOM_DEX_REDIRECT_URI":         cfg.dexRedirectURI,
		"WECOM_INTEGRATION_CONFIG_URL":   cfg.integrationConfigURL,
		"WECOM_AUTH_BRIDGE_CONFIG_TOKEN": cfg.integrationConfigToken,
	} {
		if strings.TrimSpace(value) == "" {
			return config{}, errors.New(label + " is required")
		}
	}
	if len(cfg.clientSecret) < 24 || len(cfg.integrationConfigToken) < 24 {
		return config{}, errors.New("OIDC client secret and internal config token must be at least 24 characters")
	}
	if cfg.accessTokenLifetime <= 0 || cfg.refreshTokenLifetime <= 0 || cfg.requestLifetime <= 0 {
		return config{}, errors.New("token and request lifetimes must be positive")
	}
	return cfg, nil
}

func envOr(name, fallback string) string {
	if value := strings.TrimSpace(os.Getenv(name)); value != "" {
		return value
	}
	return fallback
}

func durationOr(name string, fallback time.Duration) time.Duration {
	value := strings.TrimSpace(os.Getenv(name))
	if value == "" {
		return fallback
	}
	parsed, err := time.ParseDuration(value)
	if err != nil {
		return -1
	}
	return parsed
}
