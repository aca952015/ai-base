package main

import (
	"context"
	"crypto/subtle"
	"encoding/json"
	"errors"
	"log/slog"
	"net/http"
	"net/http/httputil"
	"net/url"
	"strings"
	"time"
)

const sessionHeader = "Mcp-Session-Id"

type contextKey string

const (
	identityContextKey        contextKey = "identity"
	upstreamSessionContextKey contextKey = "upstream-session"
	externalSessionContextKey contextKey = "external-session"
)

type mcpGateway struct {
	cfg      config
	verifier tokenVerifier
	sessions *sessionSigner
	clients  *authenticatedClientRegistry
	proxy    *httputil.ReverseProxy
}

func newMCPGateway(cfg config, verifier tokenVerifier) *mcpGateway {
	gateway := &mcpGateway{
		cfg:      cfg,
		verifier: verifier,
		sessions: newSessionSigner(cfg.signingKey, cfg.sessionLifetime),
		clients:  newAuthenticatedClientRegistry(),
	}
	gateway.proxy = gateway.newReverseProxy(cfg.upstreamURL)
	return gateway
}

func (g *mcpGateway) routes() http.Handler {
	mux := http.NewServeMux()
	g.registerRoutes(mux)
	return securityHeaders(mux)
}

func (g *mcpGateway) registerRoutes(mux *http.ServeMux) {
	mux.HandleFunc("GET /health", g.health)
	mux.HandleFunc("GET /ready", g.ready)
	mux.HandleFunc("GET /.well-known/oauth-protected-resource", g.protectedResourceMetadata)
	mux.HandleFunc("GET /.well-known/oauth-protected-resource/mcp", g.protectedResourceMetadata)
	mux.HandleFunc("GET /internal/v1/authentication/mcp-clients", g.authenticatedClients)
	mux.Handle("/mcp", g.authenticate(http.HandlerFunc(g.proxyMCP)))
	mux.Handle("/mcp/", g.authenticate(http.HandlerFunc(g.proxyMCP)))
}

func (g *mcpGateway) health(w http.ResponseWriter, _ *http.Request) {
	writeJSON(w, http.StatusOK, map[string]string{
		"status":  "ok",
		"service": "ai-base-mcp-access-gateway",
	})
}

func (g *mcpGateway) ready(w http.ResponseWriter, _ *http.Request) {
	writeJSON(w, http.StatusOK, map[string]string{
		"status":   "ready",
		"service":  "ai-base-mcp-access-gateway",
		"upstream": g.cfg.upstreamURL.Host,
	})
}

func (g *mcpGateway) protectedResourceMetadata(w http.ResponseWriter, _ *http.Request) {
	writeJSON(w, http.StatusOK, map[string]interface{}{
		"resource":                 g.cfg.resourceURL,
		"authorization_servers":    []string{g.cfg.issuer},
		"bearer_methods_supported": []string{"header"},
		"scopes_supported":         g.cfg.requiredScopes,
		"resource_name":            "AI Base MCP",
	})
}

func (g *mcpGateway) authenticatedClients(w http.ResponseWriter, r *http.Request) {
	token, err := bearerToken(r.Header.Get("Authorization"))
	if err != nil ||
		subtle.ConstantTimeCompare([]byte(token), []byte(g.cfg.adminToken)) != 1 {
		writeJSON(w, http.StatusUnauthorized, map[string]string{
			"error":             "unauthorized",
			"error_description": "A valid MCP administration token is required",
		})
		return
	}
	writeJSON(w, http.StatusOK, g.clients.snapshot())
}

func (g *mcpGateway) authenticate(next http.Handler) http.Handler {
	return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if r.URL.Query().Has("access_token") {
			writeJSON(w, http.StatusBadRequest, map[string]string{
				"error":             "invalid_request",
				"error_description": "Access tokens must be sent in the Authorization header",
			})
			return
		}

		rawToken, err := bearerToken(r.Header.Get("Authorization"))
		if err != nil {
			g.writeAuthError(w, http.StatusUnauthorized, "invalid_token")
			return
		}

		caller, err := g.verifier.verify(r.Context(), rawToken)
		if err != nil {
			if errors.Is(err, errInsufficientScope) {
				g.writeAuthError(w, http.StatusForbidden, "insufficient_scope")
				return
			}
			g.writeAuthError(w, http.StatusUnauthorized, "invalid_token")
			return
		}

		ctx := context.WithValue(r.Context(), identityContextKey, caller)
		externalSession := r.Header.Get(sessionHeader)
		if externalSession != "" {
			upstreamSession, err := g.sessions.open(externalSession, caller)
			if err != nil {
				writeJSON(w, http.StatusForbidden, map[string]string{
					"error":             "invalid_mcp_session",
					"error_description": "MCP session does not belong to the authenticated identity or has expired",
				})
				return
			}
			ctx = context.WithValue(ctx, upstreamSessionContextKey, upstreamSession)
			ctx = context.WithValue(ctx, externalSessionContextKey, externalSession)
		}

		g.clients.record(caller, r)
		next.ServeHTTP(w, r.WithContext(ctx))
	})
}

func (g *mcpGateway) proxyMCP(w http.ResponseWriter, r *http.Request) {
	g.proxy.ServeHTTP(w, r)
}

func (g *mcpGateway) writeAuthError(w http.ResponseWriter, status int, code string) {
	w.Header().Set(
		"WWW-Authenticate",
		`Bearer resource_metadata="`+g.cfg.metadataURL+`", error="`+code+`"`,
	)
	writeJSON(w, status, map[string]string{
		"error":             code,
		"error_description": http.StatusText(status),
	})
}

func (g *mcpGateway) newReverseProxy(upstream *url.URL) *httputil.ReverseProxy {
	proxy := &httputil.ReverseProxy{
		Rewrite: func(request *httputil.ProxyRequest) {
			request.SetURL(upstream)
			request.Out.URL.Path = joinURLPath(upstream.Path, strings.TrimPrefix(request.In.URL.Path, "/mcp"))
			request.Out.Host = upstream.Host
			request.Out.Header.Del("Authorization")
			request.Out.Header.Del("Proxy-Authorization")
			request.Out.Header.Del("Cookie")
			request.Out.Header.Del("X-Pomerium-Jwt-Assertion")
			request.Out.Header.Del("X-Pomerium-Claim-Email")
			request.Out.Header.Del("X-Forwarded-Access-Token")
			request.Out.Header.Del("X-Auth-Request-Access-Token")
			request.Out.Header.Del(sessionHeader)
			if upstreamSession, ok := request.In.Context().Value(upstreamSessionContextKey).(string); ok {
				request.Out.Header.Set(sessionHeader, upstreamSession)
			}
			request.SetXForwarded()
		},
		ModifyResponse: func(response *http.Response) error {
			upstreamSession := response.Header.Get(sessionHeader)
			if upstreamSession == "" {
				return nil
			}

			if externalSession, ok := response.Request.Context().Value(externalSessionContextKey).(string); ok {
				if currentUpstream, err := g.sessions.open(
					externalSession,
					response.Request.Context().Value(identityContextKey).(identity),
				); err == nil && currentUpstream == upstreamSession {
					response.Header.Set(sessionHeader, externalSession)
					return nil
				}
			}

			sealed, err := g.sessions.seal(
				upstreamSession,
				response.Request.Context().Value(identityContextKey).(identity),
			)
			if err != nil {
				return err
			}
			response.Header.Set(sessionHeader, sealed)
			return nil
		},
		ErrorHandler: func(w http.ResponseWriter, _ *http.Request, err error) {
			slog.Error("MCP upstream request failed", "error", err)
			writeJSON(w, http.StatusBadGateway, map[string]string{
				"error":             "mcp_upstream_unavailable",
				"error_description": "Envoy MCP registry is unavailable",
			})
		},
		FlushInterval: -1,
	}
	proxy.Transport = &http.Transport{
		Proxy:                 http.ProxyFromEnvironment,
		MaxIdleConns:          100,
		MaxIdleConnsPerHost:   20,
		IdleConnTimeout:       90 * time.Second,
		ResponseHeaderTimeout: 30 * time.Second,
		ForceAttemptHTTP2:     true,
	}
	return proxy
}

func joinURLPath(base, suffix string) string {
	if suffix == "" {
		return strings.TrimRight(base, "/")
	}
	return strings.TrimRight(base, "/") + "/" + strings.TrimLeft(suffix, "/")
}

func securityHeaders(next http.Handler) http.Handler {
	return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		w.Header().Set("Cache-Control", "no-store")
		w.Header().Set("X-Content-Type-Options", "nosniff")
		next.ServeHTTP(w, r)
	})
}

func writeJSON(w http.ResponseWriter, status int, value interface{}) {
	w.Header().Set("Content-Type", "application/json")
	w.WriteHeader(status)
	_ = json.NewEncoder(w).Encode(value)
}
