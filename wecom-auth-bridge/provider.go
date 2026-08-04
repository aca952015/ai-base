package main

import (
	"crypto/sha256"
	"crypto/subtle"
	"encoding/base64"
	"encoding/json"
	"html/template"
	"log/slog"
	"net/http"
	"net/url"
	"strings"
	"sync"
	"time"
)

const stateCookieName = "ai_base_wecom_oidc_state"

type authorizationRequest struct {
	ClientID            string
	RedirectURI         string
	State               string
	Nonce               string
	Scope               string
	CodeChallenge       string
	CodeChallengeMethod string
	CreatedAt           time.Time
}

type authorizationGrant struct {
	ClientID            string
	RedirectURI         string
	Identity            identity
	Nonce               string
	Scope               string
	CodeChallenge       string
	CodeChallengeMethod string
	CreatedAt           time.Time
}

type accessGrant struct {
	ClientID  string
	Identity  identity
	Scope     string
	ExpiresAt time.Time
}

type provider struct {
	cfg         config
	credentials credentialProvider
	wecom       *wecomClient
	signer      *signer
	refresh     *refreshStore
	mu          sync.Mutex
	pending     map[string]authorizationRequest
	codes       map[string]authorizationGrant
	access      map[string]accessGrant
}

func newProvider(cfg config, credentials credentialProvider, wecom *wecomClient, signer *signer, refresh *refreshStore) *provider {
	return &provider{
		cfg:         cfg,
		credentials: credentials,
		wecom:       wecom,
		signer:      signer,
		refresh:     refresh,
		pending:     make(map[string]authorizationRequest),
		codes:       make(map[string]authorizationGrant),
		access:      make(map[string]accessGrant),
	}
}

func (p *provider) routes() http.Handler {
	mux := http.NewServeMux()
	mux.HandleFunc("GET /.well-known/openid-configuration", p.discovery)
	mux.HandleFunc("GET /authorize", p.authorize)
	mux.HandleFunc("GET /callback", p.callback)
	mux.HandleFunc("POST /token", p.token)
	mux.HandleFunc("GET /userinfo", p.userinfo)
	mux.HandleFunc("POST /userinfo", p.userinfo)
	mux.HandleFunc("GET /jwks", p.jwks)
	mux.HandleFunc("GET /health", p.health)
	mux.HandleFunc("GET /ready", p.health)
	return securityHeaders(mux)
}

func (p *provider) discovery(w http.ResponseWriter, _ *http.Request) {
	writeJSON(w, http.StatusOK, map[string]any{
		"issuer":                                p.cfg.issuer,
		"authorization_endpoint":                p.cfg.publicBaseURL + "/authorize",
		"token_endpoint":                        p.cfg.issuer + "/token",
		"userinfo_endpoint":                     p.cfg.issuer + "/userinfo",
		"jwks_uri":                              p.cfg.issuer + "/jwks",
		"scopes_supported":                      []string{"openid", "profile", "email", "groups", "offline_access"},
		"response_types_supported":              []string{"code"},
		"response_modes_supported":              []string{"query"},
		"grant_types_supported":                 []string{"authorization_code", "refresh_token"},
		"subject_types_supported":               []string{"public"},
		"id_token_signing_alg_values_supported": []string{"RS256"},
		"token_endpoint_auth_methods_supported": []string{"client_secret_basic", "client_secret_post"},
		"claims_supported":                      []string{"sub", "email", "email_verified", "name", "preferred_username", "groups"},
		"code_challenge_methods_supported":      []string{"S256"},
	})
}

func (p *provider) authorize(w http.ResponseWriter, r *http.Request) {
	query := r.URL.Query()
	redirectURI := query.Get("redirect_uri")
	if subtle.ConstantTimeCompare([]byte(query.Get("client_id")), []byte(p.cfg.clientID)) != 1 || redirectURI != p.cfg.dexRedirectURI {
		writeOAuthPage(w, http.StatusBadRequest, "无效的 OIDC 客户端或回调地址")
		return
	}
	if query.Get("response_type") != "code" {
		p.redirectOAuthError(w, r, redirectURI, query.Get("state"), "unsupported_response_type", "only authorization code is supported")
		return
	}
	scopes := strings.Fields(query.Get("scope"))
	if !contains(scopes, "openid") {
		p.redirectOAuthError(w, r, redirectURI, query.Get("state"), "invalid_scope", "openid scope is required")
		return
	}
	challenge := query.Get("code_challenge")
	method := query.Get("code_challenge_method")
	if challenge != "" && method != "S256" {
		p.redirectOAuthError(w, r, redirectURI, query.Get("state"), "invalid_request", "only S256 PKCE is supported")
		return
	}
	credential, err := p.credentials.Credential(r.Context())
	if err != nil {
		slog.Warn("WeCom integration unavailable", "error", err)
		writeOAuthPage(w, http.StatusServiceUnavailable, "企业微信应用尚未配置或当前不可用，请联系管理员检查 AI Base 集成管理")
		return
	}
	internalState, err := randomToken(32)
	if err != nil {
		writeOAuthPage(w, http.StatusInternalServerError, "无法创建认证请求")
		return
	}
	p.mu.Lock()
	p.cleanupLocked(time.Now())
	p.pending[internalState] = authorizationRequest{
		ClientID:            query.Get("client_id"),
		RedirectURI:         redirectURI,
		State:               query.Get("state"),
		Nonce:               query.Get("nonce"),
		Scope:               strings.Join(scopes, " "),
		CodeChallenge:       challenge,
		CodeChallengeMethod: method,
		CreatedAt:           time.Now(),
	}
	p.mu.Unlock()
	http.SetCookie(w, &http.Cookie{
		Name:     stateCookieName,
		Value:    internalState,
		Path:     p.cfg.publicCookiePath,
		HttpOnly: true,
		Secure:   p.cfg.secureCookie,
		SameSite: http.SameSiteLaxMode,
		MaxAge:   int(p.cfg.requestLifetime.Seconds()),
	})
	authorizeURL, err := url.Parse(p.cfg.authorizationURL)
	if err != nil {
		writeOAuthPage(w, http.StatusInternalServerError, "企业微信授权地址配置无效")
		return
	}
	wecomQuery := authorizeURL.Query()
	wecomQuery.Set("appid", credential.CorpID)
	wecomQuery.Set("redirect_uri", p.cfg.publicCallbackURL)
	wecomQuery.Set("response_type", "code")
	wecomQuery.Set("scope", "snsapi_base")
	wecomQuery.Set("state", internalState)
	authorizeURL.RawQuery = wecomQuery.Encode()
	authorizeURL.Fragment = "wechat_redirect"
	http.Redirect(w, r, authorizeURL.String(), http.StatusFound)
}

func (p *provider) callback(w http.ResponseWriter, r *http.Request) {
	state := r.URL.Query().Get("state")
	cookie, err := r.Cookie(stateCookieName)
	if err != nil || state == "" || subtle.ConstantTimeCompare([]byte(cookie.Value), []byte(state)) != 1 {
		writeOAuthPage(w, http.StatusBadRequest, "认证状态无效或已经过期，请重新登录")
		return
	}
	p.mu.Lock()
	request, ok := p.pending[state]
	delete(p.pending, state)
	p.mu.Unlock()
	clearStateCookie(w, p.cfg)
	if !ok || time.Since(request.CreatedAt) > p.cfg.requestLifetime {
		writeOAuthPage(w, http.StatusBadRequest, "认证请求已经过期，请重新登录")
		return
	}
	if errorCode := r.URL.Query().Get("error"); errorCode != "" {
		p.redirectOAuthError(w, r, request.RedirectURI, request.State, errorCode, r.URL.Query().Get("error_description"))
		return
	}
	code := strings.TrimSpace(r.URL.Query().Get("code"))
	if code == "" {
		p.redirectOAuthError(w, r, request.RedirectURI, request.State, "access_denied", "WeCom authorization did not return a code")
		return
	}
	credential, err := p.credentials.Credential(r.Context())
	if err != nil {
		writeOAuthPage(w, http.StatusServiceUnavailable, "企业微信应用配置当前不可用，请重新登录")
		return
	}
	user, err := p.wecom.exchange(r.Context(), credential, code, p.cfg.emailDomain)
	if err != nil {
		slog.Warn("WeCom authorization exchange failed", "error", err)
		writeOAuthPage(w, http.StatusBadGateway, "企业微信身份校验失败，请重新登录或联系管理员")
		return
	}
	authorizationCode, err := randomToken(48)
	if err != nil {
		writeOAuthPage(w, http.StatusInternalServerError, "无法签发认证结果")
		return
	}
	p.mu.Lock()
	p.codes[tokenHash(authorizationCode)] = authorizationGrant{
		ClientID:            request.ClientID,
		RedirectURI:         request.RedirectURI,
		Identity:            user,
		Nonce:               request.Nonce,
		Scope:               request.Scope,
		CodeChallenge:       request.CodeChallenge,
		CodeChallengeMethod: request.CodeChallengeMethod,
		CreatedAt:           time.Now(),
	}
	p.mu.Unlock()
	callback, _ := url.Parse(request.RedirectURI)
	query := callback.Query()
	query.Set("code", authorizationCode)
	if request.State != "" {
		query.Set("state", request.State)
	}
	callback.RawQuery = query.Encode()
	http.Redirect(w, r, callback.String(), http.StatusFound)
}

func (p *provider) token(w http.ResponseWriter, r *http.Request) {
	r.Body = http.MaxBytesReader(w, r.Body, 1<<20)
	if err := r.ParseForm(); err != nil {
		writeOAuthError(w, http.StatusBadRequest, "invalid_request", "invalid form body")
		return
	}
	clientID, clientSecret := clientCredentials(r)
	if !p.validClient(clientID, clientSecret) {
		w.Header().Set("WWW-Authenticate", `Basic realm="wecom-oidc"`)
		writeOAuthError(w, http.StatusUnauthorized, "invalid_client", "client authentication failed")
		return
	}
	switch r.Form.Get("grant_type") {
	case "authorization_code":
		p.exchangeCode(w, r, clientID)
	case "refresh_token":
		p.refreshTokens(w, r, clientID)
	default:
		writeOAuthError(w, http.StatusBadRequest, "unsupported_grant_type", "unsupported grant type")
	}
}

func (p *provider) exchangeCode(w http.ResponseWriter, r *http.Request, clientID string) {
	codeHash := tokenHash(r.Form.Get("code"))
	p.mu.Lock()
	grant, ok := p.codes[codeHash]
	delete(p.codes, codeHash)
	p.mu.Unlock()
	if !ok || grant.ClientID != clientID || grant.RedirectURI != r.Form.Get("redirect_uri") || time.Since(grant.CreatedAt) > p.cfg.requestLifetime {
		writeOAuthError(w, http.StatusBadRequest, "invalid_grant", "authorization code is invalid or expired")
		return
	}
	if grant.CodeChallenge != "" {
		verifierDigest := sha256.Sum256([]byte(r.Form.Get("code_verifier")))
		actual := base64.RawURLEncoding.EncodeToString(verifierDigest[:])
		if subtle.ConstantTimeCompare([]byte(actual), []byte(grant.CodeChallenge)) != 1 {
			writeOAuthError(w, http.StatusBadRequest, "invalid_grant", "PKCE verification failed")
			return
		}
	}
	refreshToken, err := p.refresh.issue(clientID, grant.Identity, grant.Scope)
	if err != nil {
		slog.Error("persist refresh token failed", "error", err)
		writeOAuthError(w, http.StatusInternalServerError, "server_error", "could not persist refresh token")
		return
	}
	p.issueTokenResponse(w, clientID, grant.Identity, grant.Scope, grant.Nonce, refreshToken)
}

func (p *provider) refreshTokens(w http.ResponseWriter, r *http.Request, clientID string) {
	grant, err := p.refresh.use(r.Form.Get("refresh_token"), clientID)
	if err != nil {
		writeOAuthError(w, http.StatusBadRequest, "invalid_grant", "refresh token is invalid or expired")
		return
	}
	p.issueTokenResponse(w, clientID, grant.Identity, grant.Scope, "", r.Form.Get("refresh_token"))
}

func (p *provider) issueTokenResponse(w http.ResponseWriter, clientID string, user identity, scope, nonce, refreshToken string) {
	accessToken, err := randomToken(48)
	if err != nil {
		writeOAuthError(w, http.StatusInternalServerError, "server_error", "could not create access token")
		return
	}
	now := time.Now().UTC()
	expiresAt := now.Add(p.cfg.accessTokenLifetime)
	p.mu.Lock()
	p.cleanupLocked(now)
	p.access[tokenHash(accessToken)] = accessGrant{ClientID: clientID, Identity: user, Scope: scope, ExpiresAt: expiresAt}
	p.mu.Unlock()
	accessDigest := sha256.Sum256([]byte(accessToken))
	claims := map[string]any{
		"iss":                p.cfg.issuer,
		"sub":                user.Subject,
		"aud":                clientID,
		"exp":                expiresAt.Unix(),
		"iat":                now.Unix(),
		"auth_time":          now.Unix(),
		"at_hash":            base64.RawURLEncoding.EncodeToString(accessDigest[:len(accessDigest)/2]),
		"email":              user.Email,
		"email_verified":     true,
		"name":               user.Name,
		"preferred_username": user.PreferredUsername,
		"groups":             user.Groups,
	}
	if nonce != "" {
		claims["nonce"] = nonce
	}
	idToken, err := p.signer.sign(claims)
	if err != nil {
		writeOAuthError(w, http.StatusInternalServerError, "server_error", "could not sign ID token")
		return
	}
	writeJSON(w, http.StatusOK, map[string]any{
		"access_token":  accessToken,
		"token_type":    "Bearer",
		"expires_in":    int64(p.cfg.accessTokenLifetime.Seconds()),
		"refresh_token": refreshToken,
		"id_token":      idToken,
		"scope":         scope,
	})
}

func (p *provider) userinfo(w http.ResponseWriter, r *http.Request) {
	token := bearerToken(r)
	if token == "" && r.Method == http.MethodPost {
		_ = r.ParseForm()
		token = r.Form.Get("access_token")
	}
	p.mu.Lock()
	grant, ok := p.access[tokenHash(token)]
	p.mu.Unlock()
	if token == "" || !ok || time.Now().After(grant.ExpiresAt) {
		w.Header().Set("WWW-Authenticate", `Bearer error="invalid_token"`)
		writeOAuthError(w, http.StatusUnauthorized, "invalid_token", "access token is invalid or expired")
		return
	}
	writeJSON(w, http.StatusOK, map[string]any{
		"sub":                grant.Identity.Subject,
		"email":              grant.Identity.Email,
		"email_verified":     true,
		"name":               grant.Identity.Name,
		"preferred_username": grant.Identity.PreferredUsername,
		"groups":             grant.Identity.Groups,
	})
}

func (p *provider) jwks(w http.ResponseWriter, _ *http.Request) {
	writeJSON(w, http.StatusOK, p.signer.jwks())
}

func (p *provider) health(w http.ResponseWriter, _ *http.Request) {
	writeJSON(w, http.StatusOK, map[string]string{"status": "ok", "service": "wecom-auth-bridge"})
}

func (p *provider) validClient(clientID, clientSecret string) bool {
	return subtle.ConstantTimeCompare([]byte(clientID), []byte(p.cfg.clientID)) == 1 &&
		subtle.ConstantTimeCompare([]byte(clientSecret), []byte(p.cfg.clientSecret)) == 1
}

func (p *provider) cleanupLocked(now time.Time) {
	for key, request := range p.pending {
		if now.Sub(request.CreatedAt) > p.cfg.requestLifetime {
			delete(p.pending, key)
		}
	}
	for key, grant := range p.codes {
		if now.Sub(grant.CreatedAt) > p.cfg.requestLifetime {
			delete(p.codes, key)
		}
	}
	for key, grant := range p.access {
		if now.After(grant.ExpiresAt) {
			delete(p.access, key)
		}
	}
}

func (p *provider) redirectOAuthError(w http.ResponseWriter, r *http.Request, redirectURI, state, code, description string) {
	callback, err := url.Parse(redirectURI)
	if err != nil {
		writeOAuthPage(w, http.StatusBadRequest, description)
		return
	}
	query := callback.Query()
	query.Set("error", code)
	if description != "" {
		query.Set("error_description", description)
	}
	if state != "" {
		query.Set("state", state)
	}
	callback.RawQuery = query.Encode()
	http.Redirect(w, r, callback.String(), http.StatusFound)
}

func clientCredentials(r *http.Request) (string, string) {
	if clientID, secret, ok := r.BasicAuth(); ok {
		return clientID, secret
	}
	return r.Form.Get("client_id"), r.Form.Get("client_secret")
}

func bearerToken(r *http.Request) string {
	value := strings.TrimSpace(r.Header.Get("Authorization"))
	if len(value) > 7 && strings.EqualFold(value[:7], "Bearer ") {
		return strings.TrimSpace(value[7:])
	}
	return ""
}

func contains(values []string, wanted string) bool {
	for _, value := range values {
		if value == wanted {
			return true
		}
	}
	return false
}

func clearStateCookie(w http.ResponseWriter, cfg config) {
	http.SetCookie(w, &http.Cookie{
		Name:     stateCookieName,
		Value:    "",
		Path:     cfg.publicCookiePath,
		HttpOnly: true,
		Secure:   cfg.secureCookie,
		SameSite: http.SameSiteLaxMode,
		MaxAge:   -1,
	})
}

func securityHeaders(next http.Handler) http.Handler {
	return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		w.Header().Set("X-Content-Type-Options", "nosniff")
		w.Header().Set("X-Frame-Options", "DENY")
		w.Header().Set("Referrer-Policy", "no-referrer")
		w.Header().Set("Content-Security-Policy", "default-src 'none'; style-src 'unsafe-inline'; base-uri 'none'; frame-ancestors 'none'")
		next.ServeHTTP(w, r)
	})
}

func writeJSON(w http.ResponseWriter, status int, value any) {
	w.Header().Set("Content-Type", "application/json")
	w.Header().Set("Cache-Control", "no-store")
	w.WriteHeader(status)
	_ = json.NewEncoder(w).Encode(value)
}

func writeOAuthError(w http.ResponseWriter, status int, code, description string) {
	writeJSON(w, status, map[string]string{"error": code, "error_description": description})
}

var errorPage = template.Must(template.New("error").Parse(`<!doctype html><html lang="zh-CN"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width"><title>AI Base 企业微信认证</title><style>body{margin:0;background:#f5f5f7;color:#1d1d1f;font:16px/1.6 -apple-system,BlinkMacSystemFont,"PingFang SC","Microsoft YaHei",sans-serif}.card{max-width:520px;margin:12vh auto;padding:32px;border:1px solid #d2d2d7;border-radius:18px;background:#fff;box-shadow:0 12px 36px #0001}h1{font-size:24px;margin:0 0 12px}p{margin:0;color:#6e6e73}</style></head><body><main class="card"><h1>企业微信认证未完成</h1><p>{{.}}</p></main></body></html>`))

func writeOAuthPage(w http.ResponseWriter, status int, message string) {
	if strings.TrimSpace(message) == "" {
		message = "认证请求无法完成，请重新登录"
	}
	w.Header().Set("Content-Type", "text/html; charset=utf-8")
	w.Header().Set("Cache-Control", "no-store")
	w.WriteHeader(status)
	_ = errorPage.Execute(w, message)
}
