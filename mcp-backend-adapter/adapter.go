package main

import (
	"bytes"
	"crypto/hmac"
	"crypto/rand"
	"crypto/sha256"
	"crypto/subtle"
	"encoding/base64"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"log/slog"
	"mime"
	"net/http"
	"net/url"
	"os"
	"path/filepath"
	"strings"
	"time"
)

const (
	mcpSessionHeader          = "Mcp-Session-Id"
	statelessSessionPrefix    = "ai-base-stateless-v1."
	maxAdapterRequestBodySize = 8 << 20
)

type storedMCPServers struct {
	Servers []storedMCPServer `json:"servers"`
}

type storedMCPServer struct {
	ID         string `json:"id"`
	Namespace  string `json:"namespace"`
	URL        string `json:"url"`
	Enabled    bool   `json:"enabled"`
	AuthHeader string `json:"authHeader"`
}

type resolvedMCPServer struct {
	storedMCPServer
	target *url.URL
	secret string
}

type mcpBackendAdapter struct {
	cfg       config
	client    *http.Client
	sessions  *statelessSessionSigner
	transport *http.Transport
}

func newMCPBackendAdapter(cfg config) *mcpBackendAdapter {
	transport := &http.Transport{
		Proxy:                 http.ProxyFromEnvironment,
		MaxIdleConns:          100,
		MaxIdleConnsPerHost:   20,
		IdleConnTimeout:       90 * time.Second,
		ResponseHeaderTimeout: 30 * time.Second,
		ForceAttemptHTTP2:     true,
	}
	return &mcpBackendAdapter{
		cfg:       cfg,
		transport: transport,
		client: &http.Client{
			Transport: transport,
			CheckRedirect: func(_ *http.Request, _ []*http.Request) error {
				return errors.New("MCP backend redirects are disabled")
			},
		},
		sessions: &statelessSessionSigner{key: cfg.signingKey},
	}
}

func (a *mcpBackendAdapter) routes() http.Handler {
	mux := http.NewServeMux()
	mux.HandleFunc("GET /health", a.health)
	mux.HandleFunc("GET /ready", a.ready)
	mux.HandleFunc("/internal/v1/mcp-backends/{namespace}", a.proxy)
	return securityHeaders(mux)
}

func (a *mcpBackendAdapter) health(w http.ResponseWriter, _ *http.Request) {
	writeJSON(w, http.StatusOK, map[string]string{"status": "ok", "service": "ai-base-mcp-backend-adapter"})
}

func (a *mcpBackendAdapter) ready(w http.ResponseWriter, _ *http.Request) {
	writeJSON(w, http.StatusOK, map[string]string{"status": "ready", "service": "ai-base-mcp-backend-adapter"})
}

func (a *mcpBackendAdapter) proxy(w http.ResponseWriter, r *http.Request) {
	if r.Method != http.MethodPost && r.Method != http.MethodGet && r.Method != http.MethodDelete {
		w.Header().Set("Allow", "GET, POST, DELETE")
		writeJSON(w, http.StatusMethodNotAllowed, map[string]string{"error": "method_not_allowed"})
		return
	}
	namespace := r.PathValue("namespace")
	server, err := a.resolveServer(namespace)
	if err != nil {
		status := http.StatusBadGateway
		if errors.Is(err, errUnknownMCPNamespace) {
			status = http.StatusNotFound
		}
		writeJSON(w, status, map[string]string{"error": "mcp_backend_unavailable"})
		return
	}

	incomingSession := strings.TrimSpace(r.Header.Get(mcpSessionHeader))
	statelessSession := false
	if strings.HasPrefix(incomingSession, statelessSessionPrefix) {
		if !a.sessions.valid(incomingSession, namespace) {
			writeJSON(w, http.StatusBadRequest, map[string]string{"error": "invalid_mcp_backend_session"})
			return
		}
		statelessSession = true
	}
	if r.Method == http.MethodDelete && statelessSession {
		w.WriteHeader(http.StatusNoContent)
		return
	}

	body, initialize, err := readAdapterRequestBody(r)
	if err != nil {
		writeJSON(w, http.StatusRequestEntityTooLarge, map[string]string{"error": "mcp_request_too_large"})
		return
	}
	target := *server.target
	target.RawQuery = r.URL.RawQuery
	outgoing, err := http.NewRequestWithContext(r.Context(), r.Method, target.String(), bytes.NewReader(body))
	if err != nil {
		writeJSON(w, http.StatusBadGateway, map[string]string{"error": "mcp_backend_unavailable"})
		return
	}
	copyMCPRequestHeaders(outgoing.Header, r.Header)
	if incomingSession != "" && !statelessSession {
		outgoing.Header.Set(mcpSessionHeader, incomingSession)
	}
	if server.secret != "" {
		value := server.secret
		if strings.EqualFold(server.AuthHeader, "Authorization") {
			value = "Bearer " + value
		}
		outgoing.Header.Set(server.AuthHeader, value)
	}

	started := time.Now()
	response, err := a.client.Do(outgoing)
	if err != nil {
		slog.Warn("custom MCP backend request failed", "namespace", namespace, "error_type", fmt.Sprintf("%T", err))
		writeJSON(w, http.StatusBadGateway, map[string]string{"error": "mcp_backend_unavailable"})
		return
	}
	defer response.Body.Close()
	copyMCPResponseHeaders(w.Header(), response.Header)
	if initialize && response.StatusCode >= 200 && response.StatusCode < 300 && response.Header.Get(mcpSessionHeader) == "" {
		sessionID, sealErr := a.sessions.seal(namespace)
		if sealErr != nil {
			writeJSON(w, http.StatusBadGateway, map[string]string{"error": "mcp_backend_unavailable"})
			return
		}
		w.Header().Set(mcpSessionHeader, sessionID)
	}
	w.WriteHeader(response.StatusCode)
	if err := copyMCPResponseBody(w, response); err != nil {
		slog.Warn("custom MCP backend response interrupted", "namespace", namespace, "error_type", fmt.Sprintf("%T", err))
	}
	slog.Info("custom MCP backend request completed", "namespace", namespace, "status", response.StatusCode, "duration_ms", time.Since(started).Milliseconds())
}

var errUnknownMCPNamespace = errors.New("unknown MCP namespace")

func (a *mcpBackendAdapter) resolveServer(namespace string) (resolvedMCPServer, error) {
	if !validNamespace(namespace) {
		return resolvedMCPServer{}, errUnknownMCPNamespace
	}
	raw, err := os.ReadFile(a.cfg.serversPath)
	if err != nil {
		return resolvedMCPServer{}, fmt.Errorf("read MCP server configuration: %w", err)
	}
	var stored storedMCPServers
	if err := json.Unmarshal(raw, &stored); err != nil {
		return resolvedMCPServer{}, fmt.Errorf("decode MCP server configuration: %w", err)
	}
	for _, server := range stored.Servers {
		if server.Namespace != namespace || !server.Enabled {
			continue
		}
		if !validIdentifier(server.ID) || !validHeaderName(server.AuthHeader) {
			return resolvedMCPServer{}, errors.New("invalid stored MCP server configuration")
		}
		target, err := url.Parse(server.URL)
		if err != nil || (target.Scheme != "http" && target.Scheme != "https") || target.Hostname() == "" ||
			target.User != nil || target.RawQuery != "" || target.Fragment != "" {
			return resolvedMCPServer{}, errors.New("invalid stored MCP server URL")
		}
		secretBytes, secretErr := os.ReadFile(filepath.Join(a.cfg.secretsPath, server.ID+".key"))
		if secretErr != nil && !errors.Is(secretErr, os.ErrNotExist) {
			return resolvedMCPServer{}, fmt.Errorf("read MCP server credential: %w", secretErr)
		}
		return resolvedMCPServer{
			storedMCPServer: server,
			target:          target,
			secret:          strings.TrimSpace(string(secretBytes)),
		}, nil
	}
	return resolvedMCPServer{}, errUnknownMCPNamespace
}

func readAdapterRequestBody(r *http.Request) ([]byte, bool, error) {
	if r.Body == nil {
		return nil, false, nil
	}
	body, err := io.ReadAll(io.LimitReader(r.Body, maxAdapterRequestBodySize+1))
	if err != nil {
		return nil, false, err
	}
	if len(body) > maxAdapterRequestBodySize {
		return nil, false, errors.New("request body too large")
	}
	var message struct {
		Method string `json:"method"`
	}
	_ = json.Unmarshal(body, &message)
	return body, message.Method == "initialize", nil
}

func copyMCPRequestHeaders(target, source http.Header) {
	for _, name := range []string{
		"Accept", "Accept-Language", "Content-Type", "Last-Event-ID", "Mcp-Protocol-Version",
		"Traceparent", "Tracestate", "Baggage", "X-AI-Base-Traffic-Origin",
	} {
		for _, value := range source.Values(name) {
			target.Add(name, value)
		}
	}
	target.Set("Accept-Encoding", "identity")
}

func copyMCPResponseHeaders(target, source http.Header) {
	for _, name := range []string{
		"Cache-Control", "Content-Type", "Mcp-Protocol-Version", mcpSessionHeader, "Retry-After",
	} {
		for _, value := range source.Values(name) {
			target.Add(name, value)
		}
	}
	if mediaType, _, err := mime.ParseMediaType(source.Get("Content-Type")); err == nil && mediaType == "application/json" {
		// Envoy AI Gateway v1.0 selects its MCP JSON response parser only for
		// this exact value; parameters such as "charset=utf-8" otherwise send a
		// valid JSON-RPC response through its SSE parser and silently lose it.
		target.Set("Content-Type", "application/json")
	}
}

func copyMCPResponseBody(w http.ResponseWriter, response *http.Response) error {
	if !strings.Contains(strings.ToLower(response.Header.Get("Content-Type")), "text/event-stream") {
		_, err := io.Copy(w, response.Body)
		return err
	}
	flusher, _ := w.(http.Flusher)
	buffer := make([]byte, 32<<10)
	for {
		read, readErr := response.Body.Read(buffer)
		if read > 0 {
			if _, err := w.Write(buffer[:read]); err != nil {
				return err
			}
			if flusher != nil {
				flusher.Flush()
			}
		}
		if readErr != nil {
			if errors.Is(readErr, io.EOF) {
				return nil
			}
			return readErr
		}
	}
}

func validNamespace(value string) bool {
	return validIdentifier(value) && len(value) <= 48 && value != "open-connector" && value != "rag"
}

func validIdentifier(value string) bool {
	if value == "" || len(value) > 48 {
		return false
	}
	first := value[0]
	if !((first >= 'a' && first <= 'z') || (first >= '0' && first <= '9')) {
		return false
	}
	for _, character := range value {
		if character >= 'a' && character <= 'z' || character >= '0' && character <= '9' || character == '-' {
			continue
		}
		return false
	}
	return true
}

func validHeaderName(value string) bool {
	if value == "" || len(value) > 100 {
		return false
	}
	for _, character := range value {
		if character >= 'a' && character <= 'z' || character >= 'A' && character <= 'Z' ||
			character >= '0' && character <= '9' || strings.ContainsRune("!#$%&'*+-.^_`|~", character) {
			continue
		}
		return false
	}
	return true
}

type statelessSessionSigner struct {
	key []byte
}

func (s *statelessSessionSigner) seal(namespace string) (string, error) {
	nonce := make([]byte, 24)
	if _, err := rand.Read(nonce); err != nil {
		return "", err
	}
	payload := base64.RawURLEncoding.EncodeToString([]byte(namespace)) + "." + base64.RawURLEncoding.EncodeToString(nonce)
	signature := s.signature(payload)
	return statelessSessionPrefix + payload + "." + base64.RawURLEncoding.EncodeToString(signature), nil
}

func (s *statelessSessionSigner) valid(token, namespace string) bool {
	encoded := strings.TrimPrefix(token, statelessSessionPrefix)
	parts := strings.Split(encoded, ".")
	if len(parts) != 3 {
		return false
	}
	decodedNamespace, err := base64.RawURLEncoding.DecodeString(parts[0])
	if err != nil || string(decodedNamespace) != namespace {
		return false
	}
	if _, err := base64.RawURLEncoding.DecodeString(parts[1]); err != nil {
		return false
	}
	signature, err := base64.RawURLEncoding.DecodeString(parts[2])
	if err != nil {
		return false
	}
	expected := s.signature(parts[0] + "." + parts[1])
	return len(signature) == len(expected) && subtle.ConstantTimeCompare(signature, expected) == 1
}

func (s *statelessSessionSigner) signature(payload string) []byte {
	mac := hmac.New(sha256.New, s.key)
	_, _ = mac.Write([]byte(payload))
	return mac.Sum(nil)
}

func securityHeaders(next http.Handler) http.Handler {
	return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		w.Header().Set("Cache-Control", "no-store")
		w.Header().Set("X-Content-Type-Options", "nosniff")
		next.ServeHTTP(w, r)
	})
}

func writeJSON(w http.ResponseWriter, status int, value any) {
	w.Header().Set("Content-Type", "application/json")
	w.WriteHeader(status)
	_ = json.NewEncoder(w).Encode(value)
}
