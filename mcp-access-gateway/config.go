package main

import (
	"errors"
	"net/url"
	"os"
	"strings"
	"time"
)

type config struct {
	listenAddress             string
	upstreamURL               *url.URL
	connectorResolverURL      *url.URL
	connectorResolverToken    string
	resourceURL               string
	metadataURL               string
	issuer                    string
	jwksURL                   string
	audience                  string
	requiredScopes            []string
	signingKey                []byte
	sessionLifetime           time.Duration
	adminToken                string
	loginIssuer               string
	loginClientID             string
	loginRedirectURL          string
	oauthSigningKeyPath       string
	oauthRefreshStorePath     string
	accessTokenLifetime       time.Duration
	refreshTokenLifetime      time.Duration
	authorizationCodeLifetime time.Duration
	loginTransactionLifetime  time.Duration
	allowedRedirectURIs       []string
}

func loadConfig() (config, error) {
	upstream, err := url.Parse(envOrDefault("MCP_UPSTREAM_URL", "http://llm-gateway:1975/mcp"))
	if err != nil || upstream.Scheme == "" || upstream.Host == "" {
		return config{}, errors.New("MCP_UPSTREAM_URL must be an absolute HTTP(S) URL")
	}

	connectorResolver, err := url.Parse(envOrDefault(
		"MCP_CONNECTOR_BINDING_RESOLVER_URL",
		"http://ai-console:3000/api/internal/connector-bindings/resolve",
	))
	if err != nil ||
		(connectorResolver.Scheme != "http" && connectorResolver.Scheme != "https") ||
		connectorResolver.Host == "" {
		return config{}, errors.New("MCP_CONNECTOR_BINDING_RESOLVER_URL must be an absolute HTTP(S) URL")
	}
	connectorResolverToken := strings.TrimSpace(envOrDefault(
		"MCP_CONNECTOR_BINDING_RESOLVER_TOKEN",
		"local-connector-binding-resolver-token-change-me",
	))
	if connectorResolverToken == "" {
		return config{}, errors.New("MCP_CONNECTOR_BINDING_RESOLVER_TOKEN must not be empty")
	}

	resourceURL := strings.TrimRight(envOrDefault("MCP_PUBLIC_RESOURCE_URL", "http://127.0.0.1:8080/mcp"), "/")
	resource, err := url.Parse(resourceURL)
	if err != nil || resource.Scheme == "" || resource.Host == "" {
		return config{}, errors.New("MCP_PUBLIC_RESOURCE_URL must be an absolute URL")
	}
	metadata := &url.URL{
		Scheme: resource.Scheme,
		Host:   resource.Host,
		Path:   "/.well-known/oauth-protected-resource" + resource.EscapedPath(),
	}

	issuer := strings.TrimRight(envOrDefault("MCP_OIDC_ISSUER", "http://127.0.0.1:8080/oauth"), "/")
	if err := validateIssuerURL("MCP_OIDC_ISSUER", issuer); err != nil {
		return config{}, err
	}

	audience := strings.TrimSpace(envOrDefault("MCP_OIDC_AUDIENCE", resourceURL))
	if audience == "" {
		return config{}, errors.New("MCP_OIDC_AUDIENCE must not be empty")
	}

	signingKey := []byte(envOrDefault("MCP_SESSION_SIGNING_KEY", "local-mcp-session-signing-key-change-me"))
	if len(signingKey) < 32 {
		return config{}, errors.New("MCP_SESSION_SIGNING_KEY must contain at least 32 bytes")
	}

	sessionLifetime, err := time.ParseDuration(envOrDefault("MCP_SESSION_LIFETIME", "2160h"))
	if err != nil || sessionLifetime <= 0 {
		return config{}, errors.New("MCP_SESSION_LIFETIME must be a positive Go duration")
	}

	adminToken := strings.TrimSpace(envOrDefault(
		"MCP_ADMIN_TOKEN",
		"local-mcp-admin-token-change-me",
	))
	if adminToken == "" {
		return config{}, errors.New("MCP_ADMIN_TOKEN must not be empty")
	}

	loginIssuer := strings.TrimRight(envOrDefault("MCP_LOGIN_OIDC_ISSUER", "http://dex.localtest.me:5556/dex"), "/")
	if err := validateIssuerURL("MCP_LOGIN_OIDC_ISSUER", loginIssuer); err != nil {
		return config{}, err
	}

	loginClientID := strings.TrimSpace(envOrDefault("MCP_LOGIN_OIDC_CLIENT_ID", "ai-base-mcp-broker"))
	if loginClientID == "" {
		return config{}, errors.New("MCP_LOGIN_OIDC_CLIENT_ID must not be empty")
	}

	loginRedirectURL := strings.TrimSpace(envOrDefault("MCP_LOGIN_OIDC_REDIRECT_URL", issuer+"/callback"))
	if parsed, parseErr := url.Parse(loginRedirectURL); parseErr != nil || parsed.Scheme == "" || parsed.Host == "" {
		return config{}, errors.New("MCP_LOGIN_OIDC_REDIRECT_URL must be an absolute URL")
	}

	accessTokenLifetime, err := positiveDuration("MCP_OAUTH_ACCESS_TOKEN_LIFETIME", "1h")
	if err != nil {
		return config{}, err
	}
	refreshTokenLifetime, err := positiveDuration("MCP_OAUTH_REFRESH_TOKEN_LIFETIME", "2160h")
	if err != nil {
		return config{}, err
	}
	authorizationCodeLifetime, err := positiveDuration("MCP_OAUTH_AUTHORIZATION_CODE_LIFETIME", "5m")
	if err != nil {
		return config{}, err
	}
	loginTransactionLifetime, err := positiveDuration("MCP_OAUTH_LOGIN_TRANSACTION_LIFETIME", "10m")
	if err != nil {
		return config{}, err
	}

	return config{
		listenAddress:             envOrDefault("MCP_LISTEN_ADDRESS", ":8081"),
		upstreamURL:               upstream,
		connectorResolverURL:      connectorResolver,
		connectorResolverToken:    connectorResolverToken,
		resourceURL:               resourceURL,
		metadataURL:               metadata.String(),
		issuer:                    issuer,
		jwksURL:                   strings.TrimSpace(envOrDefault("MCP_OIDC_JWKS_URL", "http://127.0.0.1:8081/oauth/jwks")),
		audience:                  audience,
		requiredScopes:            splitFields(envOrDefault("MCP_OIDC_REQUIRED_SCOPES", "ai-base:mcp")),
		signingKey:                signingKey,
		sessionLifetime:           sessionLifetime,
		adminToken:                adminToken,
		loginIssuer:               loginIssuer,
		loginClientID:             loginClientID,
		loginRedirectURL:          loginRedirectURL,
		oauthSigningKeyPath:       strings.TrimSpace(envOrDefault("MCP_OAUTH_SIGNING_KEY_PATH", "/data/oauth-signing-key.pem")),
		oauthRefreshStorePath:     strings.TrimSpace(envOrDefault("MCP_OAUTH_REFRESH_STORE_PATH", "/data/oauth-refresh-grants.json")),
		accessTokenLifetime:       accessTokenLifetime,
		refreshTokenLifetime:      refreshTokenLifetime,
		authorizationCodeLifetime: authorizationCodeLifetime,
		loginTransactionLifetime:  loginTransactionLifetime,
		allowedRedirectURIs: splitFields(envOrDefault(
			"MCP_OAUTH_ALLOWED_REDIRECT_URIS",
			"workbuddy://workbuddy/mcp/custom-mcp%3Aai-base/oauth/callback",
		)),
	}, nil
}

func envOrDefault(name, fallback string) string {
	if value, ok := os.LookupEnv(name); ok {
		return value
	}
	return fallback
}

func splitFields(value string) []string {
	return strings.FieldsFunc(value, func(r rune) bool {
		return r == ' ' || r == ','
	})
}

func positiveDuration(name, fallback string) (time.Duration, error) {
	value, err := time.ParseDuration(envOrDefault(name, fallback))
	if err != nil || value <= 0 {
		return 0, errors.New(name + " must be a positive Go duration")
	}
	return value, nil
}

func validateIssuerURL(name, value string) error {
	parsed, err := url.Parse(value)
	if err != nil || parsed.Hostname() == "" {
		return errors.New(name + " must be an absolute HTTP(S) URL")
	}
	if parsed.Scheme == "https" {
		return nil
	}
	if parsed.Scheme != "http" || !isLocalDevelopmentHost(parsed.Hostname()) {
		return errors.New(name + " must use HTTPS outside local development")
	}
	return nil
}

func isLocalDevelopmentHost(host string) bool {
	host = strings.ToLower(strings.TrimSuffix(host, "."))
	return host == "localhost" ||
		host == "127.0.0.1" ||
		host == "::1" ||
		strings.HasSuffix(host, ".localhost") ||
		strings.HasSuffix(host, ".localtest.me")
}
