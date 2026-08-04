package main

import (
	"context"
	"crypto/rand"
	"crypto/rsa"
	"crypto/sha256"
	"crypto/subtle"
	"crypto/x509"
	"encoding/base64"
	"encoding/hex"
	"encoding/json"
	"encoding/pem"
	"errors"
	"fmt"
	"net/http"
	"net/url"
	"os"
	"path/filepath"
	"slices"
	"strings"
	"sync"
	"time"

	"github.com/coreos/go-oidc/v3/oidc"
	"github.com/go-jose/go-jose/v4"
	"golang.org/x/oauth2"
)

const (
	oauthCodeChallengeMethod = "S256"
	oauthAccessTokenType     = "at+jwt"
)

type employeeIdentity struct {
	Subject         string
	Email           string
	Name            string
	Groups          []string
	WeComUserIDHash string
}

type loginProvider interface {
	authorizationURL(state, nonce, codeVerifier string) string
	exchange(context.Context, string, string, string) (employeeIdentity, error)
}

type dexLoginProvider struct {
	oauthConfig *oauth2.Config
	verifier    *oidc.IDTokenVerifier
	httpClient  *http.Client
}

func newDexLoginProvider(ctx context.Context, cfg config) (*dexLoginProvider, error) {
	httpClient := &http.Client{Timeout: 15 * time.Second}
	provider, err := oidc.NewProvider(oidc.ClientContext(ctx, httpClient), cfg.loginIssuer)
	if err != nil {
		return nil, fmt.Errorf("discover login OIDC provider: %w", err)
	}
	return &dexLoginProvider{
		oauthConfig: &oauth2.Config{
			ClientID:    cfg.loginClientID,
			RedirectURL: cfg.loginRedirectURL,
			Endpoint:    provider.Endpoint(),
			Scopes:      []string{oidc.ScopeOpenID, "profile", "email", "groups"},
		},
		verifier:   provider.Verifier(&oidc.Config{ClientID: cfg.loginClientID}),
		httpClient: httpClient,
	}, nil
}

func (p *dexLoginProvider) authorizationURL(state, nonce, codeVerifier string) string {
	return p.oauthConfig.AuthCodeURL(
		state,
		oauth2.AccessTypeOffline,
		oauth2.S256ChallengeOption(codeVerifier),
		oauth2.SetAuthURLParam("nonce", nonce),
	)
}

func (p *dexLoginProvider) exchange(
	ctx context.Context,
	code string,
	codeVerifier string,
	expectedNonce string,
) (employeeIdentity, error) {
	ctx = oidc.ClientContext(ctx, p.httpClient)
	token, err := p.oauthConfig.Exchange(ctx, code, oauth2.VerifierOption(codeVerifier))
	if err != nil {
		return employeeIdentity{}, fmt.Errorf("exchange login authorization code: %w", err)
	}

	rawIDToken, ok := token.Extra("id_token").(string)
	if !ok || rawIDToken == "" {
		return employeeIdentity{}, errors.New("login provider did not return an ID token")
	}
	idToken, err := p.verifier.Verify(ctx, rawIDToken)
	if err != nil {
		return employeeIdentity{}, fmt.Errorf("verify login ID token: %w", err)
	}

	var claims struct {
		Email             string   `json:"email"`
		Name              string   `json:"name"`
		PreferredUsername string   `json:"preferred_username"`
		Groups            []string `json:"groups"`
		Nonce             string   `json:"nonce"`
	}
	if err := idToken.Claims(&claims); err != nil {
		return employeeIdentity{}, fmt.Errorf("decode login ID token: %w", err)
	}
	if expectedNonce == "" ||
		subtle.ConstantTimeCompare([]byte(claims.Nonce), []byte(expectedNonce)) != 1 {
		return employeeIdentity{}, errors.New("login ID token nonce does not match")
	}
	name := claims.Name
	if name == "" {
		name = claims.PreferredUsername
	}
	if name == "" {
		name = claims.Email
	}
	return employeeIdentity{
		Subject:         idToken.Subject,
		Email:           claims.Email,
		Name:            name,
		Groups:          claims.Groups,
		WeComUserIDHash: deriveWeComUserIDHash(claims.PreferredUsername, claims.Groups),
	}, nil
}

func deriveWeComUserIDHash(preferredUsername string, groups []string) string {
	userID := strings.TrimSpace(preferredUsername)
	if userID == "" {
		return ""
	}

	enterpriseMarkers := 0
	for _, group := range groups {
		if strings.HasPrefix(group, "wecom:") && validLowerHex(strings.TrimPrefix(group, "wecom:"), 12) {
			enterpriseMarkers++
		}
	}
	if enterpriseMarkers != 1 {
		return ""
	}

	digest := sha256.Sum256([]byte(userID))
	return hex.EncodeToString(digest[:])
}

type loginTransaction struct {
	ClientID         string
	RedirectURI      string
	ClientState      string
	CodeChallenge    string
	Scope            string
	Resource         string
	UpstreamVerifier string
	UpstreamNonce    string
	ExpiresAt        time.Time
}

type authorizationCode struct {
	ClientID      string
	RedirectURI   string
	CodeChallenge string
	Scope         string
	Resource      string
	Employee      employeeIdentity
	ExpiresAt     time.Time
}

type refreshGrant struct {
	ClientID  string           `json:"clientId"`
	Scope     string           `json:"scope"`
	Resource  string           `json:"resource"`
	Employee  employeeIdentity `json:"employee"`
	ExpiresAt time.Time        `json:"expiresAt"`
}

type oauthBroker struct {
	cfg          config
	login        loginProvider
	signingKey   *rsa.PrivateKey
	keyID        string
	now          func() time.Time
	refreshStore *refreshGrantStore

	mu           sync.Mutex
	transactions map[string]loginTransaction
	codes        map[string]authorizationCode
	refresh      map[string]refreshGrant
}

func newOAuthBroker(cfg config, login loginProvider) (*oauthBroker, error) {
	signingKey, err := loadOrCreateRSAKey(cfg.oauthSigningKeyPath)
	if err != nil {
		return nil, err
	}
	return newOAuthBrokerWithKey(cfg, login, signingKey)
}

func newOAuthBrokerWithKey(
	cfg config,
	login loginProvider,
	signingKey *rsa.PrivateKey,
) (*oauthBroker, error) {
	if login == nil {
		return nil, errors.New("login provider is required")
	}
	if signingKey == nil {
		return nil, errors.New("OAuth signing key is required")
	}
	keyID, err := signingKeyID(&signingKey.PublicKey)
	if err != nil {
		return nil, err
	}
	refreshStore := newRefreshGrantStore(cfg.oauthRefreshStorePath)
	refresh, err := refreshStore.load(time.Now())
	if err != nil {
		return nil, err
	}
	return &oauthBroker{
		cfg:          cfg,
		login:        login,
		signingKey:   signingKey,
		keyID:        keyID,
		now:          time.Now,
		refreshStore: refreshStore,
		transactions: make(map[string]loginTransaction),
		codes:        make(map[string]authorizationCode),
		refresh:      refresh,
	}, nil
}

func applicationRoutes(gateway *mcpGateway, broker *oauthBroker) http.Handler {
	mux := http.NewServeMux()
	gateway.registerRoutes(mux)
	broker.registerRoutes(mux)
	return securityHeaders(mux)
}

func (b *oauthBroker) registerRoutes(mux *http.ServeMux) {
	mux.HandleFunc("GET /.well-known/oauth-authorization-server/oauth", b.authorizationServerMetadata)
	mux.HandleFunc("GET /.well-known/openid-configuration/oauth", b.authorizationServerMetadata)
	mux.HandleFunc("GET /oauth/.well-known/oauth-authorization-server", b.authorizationServerMetadata)
	mux.HandleFunc("GET /oauth/.well-known/openid-configuration", b.authorizationServerMetadata)
	mux.HandleFunc("GET /oauth/jwks", b.jwks)
	mux.HandleFunc("POST /oauth/register", b.registerClient)
	mux.HandleFunc("GET /oauth/authorize", b.authorize)
	mux.HandleFunc("GET /oauth/callback", b.loginCallback)
	mux.HandleFunc("POST /oauth/token", b.token)
}

func (b *oauthBroker) authorizationServerMetadata(w http.ResponseWriter, _ *http.Request) {
	writeJSON(w, http.StatusOK, map[string]interface{}{
		"issuer":                                         b.cfg.issuer,
		"authorization_endpoint":                         b.cfg.issuer + "/authorize",
		"token_endpoint":                                 b.cfg.issuer + "/token",
		"registration_endpoint":                          b.cfg.issuer + "/register",
		"jwks_uri":                                       b.cfg.issuer + "/jwks",
		"scopes_supported":                               b.supportedScopes(),
		"response_types_supported":                       []string{"code"},
		"grant_types_supported":                          []string{"authorization_code", "refresh_token"},
		"code_challenge_methods_supported":               []string{oauthCodeChallengeMethod},
		"token_endpoint_auth_methods_supported":          []string{"none"},
		"authorization_response_iss_parameter_supported": false,
	})
}

func (b *oauthBroker) jwks(w http.ResponseWriter, _ *http.Request) {
	writeJSON(w, http.StatusOK, map[string]interface{}{
		"keys": []jose.JSONWebKey{{
			Key:       &b.signingKey.PublicKey,
			KeyID:     b.keyID,
			Algorithm: string(jose.RS256),
			Use:       "sig",
		}},
	})
}

func (b *oauthBroker) registerClient(w http.ResponseWriter, r *http.Request) {
	r.Body = http.MaxBytesReader(w, r.Body, 64<<10)
	var request struct {
		RedirectURIs            []string `json:"redirect_uris"`
		ClientName              string   `json:"client_name"`
		TokenEndpointAuthMethod string   `json:"token_endpoint_auth_method"`
		GrantTypes              []string `json:"grant_types"`
		ResponseTypes           []string `json:"response_types"`
	}
	if err := json.NewDecoder(r.Body).Decode(&request); err != nil {
		writeOAuthError(w, http.StatusBadRequest, "invalid_client_metadata", "Invalid client metadata")
		return
	}
	if len(request.RedirectURIs) != 1 || !b.validRedirectURI(request.RedirectURIs[0]) {
		writeOAuthError(
			w,
			http.StatusBadRequest,
			"invalid_redirect_uri",
			"Exactly one allowed MCP client redirect URI is required",
		)
		return
	}
	if request.TokenEndpointAuthMethod == "" {
		request.TokenEndpointAuthMethod = "none"
	}
	if request.TokenEndpointAuthMethod != "none" {
		writeOAuthError(
			w,
			http.StatusBadRequest,
			"invalid_client_metadata",
			"Only public clients are supported",
		)
		return
	}
	if len(request.GrantTypes) == 0 {
		request.GrantTypes = []string{"authorization_code"}
	}
	if !containsOnly(request.GrantTypes, "authorization_code", "refresh_token") ||
		!slices.Contains(request.GrantTypes, "authorization_code") {
		writeOAuthError(
			w,
			http.StatusBadRequest,
			"invalid_client_metadata",
			"Unsupported grant type",
		)
		return
	}
	if len(request.ResponseTypes) == 0 {
		request.ResponseTypes = []string{"code"}
	}
	if !containsOnly(request.ResponseTypes, "code") {
		writeOAuthError(
			w,
			http.StatusBadRequest,
			"invalid_client_metadata",
			"Unsupported response type",
		)
		return
	}

	redirectURI := request.RedirectURIs[0]
	clientID := clientIDForRedirectURI(redirectURI)
	request.ClientName = strings.TrimSpace(request.ClientName)
	if len(request.ClientName) > 200 {
		request.ClientName = request.ClientName[:200]
	}
	writeJSON(w, http.StatusCreated, map[string]interface{}{
		"client_id":                  clientID,
		"client_id_issued_at":        b.now().Unix(),
		"client_name":                request.ClientName,
		"redirect_uris":              request.RedirectURIs,
		"token_endpoint_auth_method": "none",
		"grant_types":                request.GrantTypes,
		"response_types":             request.ResponseTypes,
	})
}

func (b *oauthBroker) authorize(w http.ResponseWriter, r *http.Request) {
	query := r.URL.Query()
	clientID := query.Get("client_id")
	redirectURI := query.Get("redirect_uri")
	clientState := query.Get("state")
	codeChallenge := query.Get("code_challenge")
	if query.Get("response_type") != "code" ||
		clientState == "" ||
		!b.validRedirectURI(redirectURI) ||
		clientID != clientIDForRedirectURI(redirectURI) ||
		query.Get("code_challenge_method") != oauthCodeChallengeMethod ||
		!validCodeChallenge(codeChallenge) {
		writeOAuthError(w, http.StatusBadRequest, "invalid_request", "Invalid authorization request")
		return
	}

	scope, err := b.normalizeScopes(query.Get("scope"))
	if err != nil {
		redirectOAuthError(w, r, redirectURI, clientState, "invalid_scope")
		return
	}
	resource := query.Get("resource")
	if resource == "" {
		resource = b.cfg.resourceURL
	}
	if resource != b.cfg.resourceURL {
		redirectOAuthError(w, r, redirectURI, clientState, "invalid_target")
		return
	}

	upstreamState, err := randomURLToken(32)
	if err != nil {
		writeOAuthError(w, http.StatusInternalServerError, "server_error", "Unable to start login")
		return
	}
	nonce, err := randomURLToken(32)
	if err != nil {
		writeOAuthError(w, http.StatusInternalServerError, "server_error", "Unable to start login")
		return
	}
	upstreamVerifier, err := randomURLToken(48)
	if err != nil {
		writeOAuthError(w, http.StatusInternalServerError, "server_error", "Unable to start login")
		return
	}

	b.mu.Lock()
	b.cleanupExpiredLocked()
	b.transactions[upstreamState] = loginTransaction{
		ClientID:         clientID,
		RedirectURI:      redirectURI,
		ClientState:      clientState,
		CodeChallenge:    codeChallenge,
		Scope:            scope,
		Resource:         resource,
		UpstreamVerifier: upstreamVerifier,
		UpstreamNonce:    nonce,
		ExpiresAt:        b.now().Add(b.cfg.loginTransactionLifetime),
	}
	b.mu.Unlock()

	http.Redirect(
		w,
		r,
		b.login.authorizationURL(upstreamState, nonce, upstreamVerifier),
		http.StatusFound,
	)
}

func (b *oauthBroker) loginCallback(w http.ResponseWriter, r *http.Request) {
	upstreamState := r.URL.Query().Get("state")
	b.mu.Lock()
	transaction, ok := b.transactions[upstreamState]
	delete(b.transactions, upstreamState)
	b.mu.Unlock()
	if !ok || transaction.ExpiresAt.Before(b.now()) {
		writeOAuthError(w, http.StatusBadRequest, "invalid_request", "Login transaction expired")
		return
	}
	if upstreamError := r.URL.Query().Get("error"); upstreamError != "" {
		redirectOAuthError(
			w,
			r,
			transaction.RedirectURI,
			transaction.ClientState,
			"access_denied",
		)
		return
	}

	employee, err := b.login.exchange(
		r.Context(),
		r.URL.Query().Get("code"),
		transaction.UpstreamVerifier,
		transaction.UpstreamNonce,
	)
	if err != nil || employee.Subject == "" {
		redirectOAuthError(
			w,
			r,
			transaction.RedirectURI,
			transaction.ClientState,
			"access_denied",
		)
		return
	}
	employee.Subject = brokerSubject(b.cfg.loginIssuer, employee.Subject)
	code, err := randomURLToken(32)
	if err != nil {
		writeOAuthError(w, http.StatusInternalServerError, "server_error", "Unable to complete login")
		return
	}

	b.mu.Lock()
	b.cleanupExpiredLocked()
	b.codes[code] = authorizationCode{
		ClientID:      transaction.ClientID,
		RedirectURI:   transaction.RedirectURI,
		CodeChallenge: transaction.CodeChallenge,
		Scope:         transaction.Scope,
		Resource:      transaction.Resource,
		Employee:      employee,
		ExpiresAt:     b.now().Add(b.cfg.authorizationCodeLifetime),
	}
	b.mu.Unlock()

	redirect, _ := url.Parse(transaction.RedirectURI)
	values := redirect.Query()
	values.Set("code", code)
	values.Set("state", transaction.ClientState)
	redirect.RawQuery = values.Encode()
	http.Redirect(w, r, redirect.String(), http.StatusFound)
}

func (b *oauthBroker) token(w http.ResponseWriter, r *http.Request) {
	r.Body = http.MaxBytesReader(w, r.Body, 64<<10)
	if err := r.ParseForm(); err != nil {
		writeOAuthError(w, http.StatusBadRequest, "invalid_request", "Invalid token request")
		return
	}
	switch r.Form.Get("grant_type") {
	case "authorization_code":
		b.exchangeAuthorizationCode(w, r)
	case "refresh_token":
		b.exchangeRefreshToken(w, r)
	default:
		writeOAuthError(w, http.StatusBadRequest, "unsupported_grant_type", "Unsupported grant type")
	}
}

func (b *oauthBroker) exchangeAuthorizationCode(w http.ResponseWriter, r *http.Request) {
	codeValue := r.Form.Get("code")
	b.mu.Lock()
	code, ok := b.codes[codeValue]
	delete(b.codes, codeValue)
	b.mu.Unlock()
	if !ok || code.ExpiresAt.Before(b.now()) {
		writeOAuthError(w, http.StatusBadRequest, "invalid_grant", "Authorization code is invalid")
		return
	}

	clientID := tokenRequestClientID(r)
	if clientID != code.ClientID ||
		r.Form.Get("redirect_uri") != code.RedirectURI ||
		!verifyPKCE(r.Form.Get("code_verifier"), code.CodeChallenge) {
		writeOAuthError(w, http.StatusBadRequest, "invalid_grant", "Authorization code validation failed")
		return
	}
	if resource := r.Form.Get("resource"); resource != "" && resource != code.Resource {
		writeOAuthError(w, http.StatusBadRequest, "invalid_target", "Resource does not match")
		return
	}
	b.writeTokenResponse(w, code.Employee, code.ClientID, code.Scope, code.Resource)
}

func (b *oauthBroker) exchangeRefreshToken(w http.ResponseWriter, r *http.Request) {
	rawToken := r.Form.Get("refresh_token")
	tokenHash := refreshTokenHash(rawToken)
	b.mu.Lock()
	b.cleanupExpiredLocked()
	grant, ok := b.refresh[tokenHash]
	b.mu.Unlock()
	if !ok || rawToken == "" || grant.ExpiresAt.Before(b.now()) {
		writeOAuthError(w, http.StatusBadRequest, "invalid_grant", "Refresh token is invalid")
		return
	}
	if tokenRequestClientID(r) != grant.ClientID {
		writeOAuthError(w, http.StatusBadRequest, "invalid_client", "Client does not match")
		return
	}
	if resource := r.Form.Get("resource"); resource != "" && resource != grant.Resource {
		writeOAuthError(w, http.StatusBadRequest, "invalid_target", "Resource does not match")
		return
	}
	scope := grant.Scope
	if requested := r.Form.Get("scope"); requested != "" {
		normalized, normalizeErr := b.normalizeScopes(requested)
		if normalizeErr != nil || !scopeSubset(normalized, grant.Scope) {
			writeOAuthError(w, http.StatusBadRequest, "invalid_scope", "Scope cannot be expanded")
			return
		}
		scope = normalized
	}

	accessToken, err := b.signAccessToken(grant.Employee, grant.ClientID, scope, grant.Resource)
	if err != nil {
		writeOAuthError(w, http.StatusInternalServerError, "server_error", "Unable to issue token")
		return
	}

	b.mu.Lock()
	currentGrant, stillValid := b.refresh[tokenHash]
	if !stillValid || currentGrant.ExpiresAt.Before(b.now()) {
		b.mu.Unlock()
		writeOAuthError(w, http.StatusBadRequest, "invalid_grant", "Refresh token is invalid")
		return
	}
	// WorkBuddy can keep more than one MCP process alive while its credential-file
	// watcher is unavailable. Reusing one sliding refresh token lets every process
	// refresh independently instead of invalidating its peers after the first use.
	renewedGrant := currentGrant
	renewedGrant.Scope = scope
	renewedGrant.ExpiresAt = b.now().Add(b.cfg.refreshTokenLifetime)
	b.refresh[tokenHash] = renewedGrant
	if err := b.persistRefreshLocked(); err != nil {
		b.refresh[tokenHash] = currentGrant
		b.mu.Unlock()
		writeOAuthError(w, http.StatusInternalServerError, "server_error", "Unable to persist token")
		return
	}
	b.mu.Unlock()

	b.writeIssuedTokenResponse(w, accessToken, rawToken, scope)
}

func (b *oauthBroker) writeTokenResponse(
	w http.ResponseWriter,
	employee employeeIdentity,
	clientID string,
	scope string,
	resource string,
) {
	accessToken, err := b.signAccessToken(employee, clientID, scope, resource)
	if err != nil {
		writeOAuthError(w, http.StatusInternalServerError, "server_error", "Unable to issue token")
		return
	}
	refreshToken, err := b.issueRefreshToken(employee, clientID, scope, resource)
	if err != nil {
		writeOAuthError(w, http.StatusInternalServerError, "server_error", "Unable to issue token")
		return
	}
	b.writeIssuedTokenResponse(w, accessToken, refreshToken, scope)
}

func (b *oauthBroker) writeIssuedTokenResponse(
	w http.ResponseWriter,
	accessToken string,
	refreshToken string,
	scope string,
) {
	writeJSON(w, http.StatusOK, map[string]interface{}{
		"access_token":  accessToken,
		"refresh_token": refreshToken,
		"token_type":    "Bearer",
		"expires_in":    int64(b.cfg.accessTokenLifetime.Seconds()),
		"scope":         scope,
	})
}

func (b *oauthBroker) signAccessToken(
	employee employeeIdentity,
	clientID string,
	scope string,
	resource string,
) (string, error) {
	now := b.now()
	tokenID, err := randomURLToken(16)
	if err != nil {
		return "", err
	}
	claims := map[string]interface{}{
		"iss":       b.cfg.issuer,
		"sub":       employee.Subject,
		"aud":       resource,
		"azp":       clientID,
		"client_id": clientID,
		"scope":     scope,
		"iat":       now.Unix(),
		"nbf":       now.Add(-5 * time.Second).Unix(),
		"exp":       now.Add(b.cfg.accessTokenLifetime).Unix(),
		"jti":       tokenID,
		"email":     employee.Email,
		"name":      employee.Name,
		"groups":    employee.Groups,
	}
	if employee.WeComUserIDHash != "" {
		claims["wecom_user_id_hash"] = employee.WeComUserIDHash
	}
	return b.signJWT(claims, oauthAccessTokenType)
}

func (b *oauthBroker) issueRefreshToken(
	employee employeeIdentity,
	clientID string,
	scope string,
	resource string,
) (string, error) {
	token, err := randomURLToken(32)
	if err != nil {
		return "", err
	}
	b.mu.Lock()
	b.cleanupExpiredLocked()
	tokenHash := refreshTokenHash(token)
	b.refresh[tokenHash] = refreshGrant{
		ClientID:  clientID,
		Scope:     scope,
		Resource:  resource,
		Employee:  employee,
		ExpiresAt: b.now().Add(b.cfg.refreshTokenLifetime),
	}
	if err := b.persistRefreshLocked(); err != nil {
		delete(b.refresh, tokenHash)
		b.mu.Unlock()
		return "", err
	}
	b.mu.Unlock()
	return token, nil
}

func (b *oauthBroker) persistRefreshLocked() error {
	return b.refreshStore.save(b.refresh)
}

func (b *oauthBroker) signJWT(claims interface{}, tokenType string) (string, error) {
	signer, err := jose.NewSigner(
		jose.SigningKey{Algorithm: jose.RS256, Key: b.signingKey},
		&jose.SignerOptions{ExtraHeaders: map[jose.HeaderKey]interface{}{
			jose.HeaderKey("kid"): b.keyID,
			jose.HeaderKey("typ"): tokenType,
		}},
	)
	if err != nil {
		return "", err
	}
	payload, err := json.Marshal(claims)
	if err != nil {
		return "", err
	}
	object, err := signer.Sign(payload)
	if err != nil {
		return "", err
	}
	return object.CompactSerialize()
}

func (b *oauthBroker) normalizeScopes(raw string) (string, error) {
	requested := strings.Fields(raw)
	if len(requested) == 0 {
		requested = append([]string(nil), b.cfg.requiredScopes...)
	}
	allowed := map[string]struct{}{
		"openid":         {},
		"offline_access": {},
	}
	for _, scope := range b.cfg.requiredScopes {
		allowed[scope] = struct{}{}
	}
	unique := make([]string, 0, len(requested))
	seen := make(map[string]struct{}, len(requested))
	for _, scope := range requested {
		if _, ok := allowed[scope]; !ok {
			return "", errInsufficientScope
		}
		if _, ok := seen[scope]; !ok {
			seen[scope] = struct{}{}
			unique = append(unique, scope)
		}
	}
	for _, required := range b.cfg.requiredScopes {
		if _, ok := seen[required]; !ok {
			return "", errInsufficientScope
		}
	}
	return strings.Join(unique, " "), nil
}

func (b *oauthBroker) supportedScopes() []string {
	scopes := []string{"openid", "offline_access"}
	for _, scope := range b.cfg.requiredScopes {
		if !slices.Contains(scopes, scope) {
			scopes = append(scopes, scope)
		}
	}
	return scopes
}

func (b *oauthBroker) cleanupExpiredLocked() {
	now := b.now()
	for state, transaction := range b.transactions {
		if transaction.ExpiresAt.Before(now) {
			delete(b.transactions, state)
		}
	}
	for code, authorization := range b.codes {
		if authorization.ExpiresAt.Before(now) {
			delete(b.codes, code)
		}
	}
	for tokenHash, grant := range b.refresh {
		if grant.ExpiresAt.Before(now) {
			delete(b.refresh, tokenHash)
		}
	}
}

func clientIDForRedirectURI(redirectURI string) string {
	digest := sha256.Sum256([]byte("ai-base-dcr-v1\x00" + redirectURI))
	return "ai-base-" + base64.RawURLEncoding.EncodeToString(digest[:24])
}

func (b *oauthBroker) validRedirectURI(raw string) bool {
	redirect, err := url.Parse(raw)
	if err != nil || redirect.Fragment != "" || redirect.User != nil {
		return false
	}
	if slices.Contains(b.cfg.allowedRedirectURIs, raw) {
		return true
	}
	if redirect.Scheme != "http" {
		return false
	}
	return isLocalDevelopmentHost(redirect.Hostname())
}

func tokenRequestClientID(r *http.Request) string {
	if clientID := r.Form.Get("client_id"); clientID != "" {
		return clientID
	}
	clientID, _, _ := r.BasicAuth()
	return clientID
}

func verifyPKCE(verifier, expectedChallenge string) bool {
	if len(verifier) < 43 || len(verifier) > 128 {
		return false
	}
	digest := sha256.Sum256([]byte(verifier))
	actual := base64.RawURLEncoding.EncodeToString(digest[:])
	return actual == expectedChallenge
}

func validCodeChallenge(challenge string) bool {
	if len(challenge) != 43 {
		return false
	}
	decoded, err := base64.RawURLEncoding.DecodeString(challenge)
	return err == nil && len(decoded) == sha256.Size
}

func brokerSubject(loginIssuer, upstreamSubject string) string {
	digest := sha256.Sum256([]byte(loginIssuer + "\x00" + upstreamSubject))
	return "usr_" + base64.RawURLEncoding.EncodeToString(digest[:])
}

func refreshTokenHash(rawToken string) string {
	digest := sha256.Sum256([]byte(rawToken))
	return base64.RawURLEncoding.EncodeToString(digest[:])
}

func scopeSubset(requested, granted string) bool {
	grantedSet := readScopes(granted)
	for scope := range readScopes(requested) {
		if _, ok := grantedSet[scope]; !ok {
			return false
		}
	}
	return true
}

func containsOnly(values []string, allowed ...string) bool {
	for _, value := range values {
		if !slices.Contains(allowed, value) {
			return false
		}
	}
	return true
}

func redirectOAuthError(
	w http.ResponseWriter,
	r *http.Request,
	redirectURI string,
	state string,
	code string,
) {
	redirect, err := url.Parse(redirectURI)
	if err != nil {
		writeOAuthError(w, http.StatusBadRequest, code, "Authorization failed")
		return
	}
	values := redirect.Query()
	values.Set("error", code)
	if state != "" {
		values.Set("state", state)
	}
	redirect.RawQuery = values.Encode()
	http.Redirect(w, r, redirect.String(), http.StatusFound)
}

func writeOAuthError(w http.ResponseWriter, status int, code, description string) {
	writeJSON(w, status, map[string]string{
		"error":             code,
		"error_description": description,
	})
}

func randomURLToken(size int) (string, error) {
	value := make([]byte, size)
	if _, err := rand.Read(value); err != nil {
		return "", err
	}
	return base64.RawURLEncoding.EncodeToString(value), nil
}

func loadOrCreateRSAKey(path string) (*rsa.PrivateKey, error) {
	if path == "" {
		return nil, errors.New("MCP_OAUTH_SIGNING_KEY_PATH must not be empty")
	}
	contents, err := os.ReadFile(path)
	if err == nil {
		return parseRSAPrivateKey(contents)
	}
	if !errors.Is(err, os.ErrNotExist) {
		return nil, fmt.Errorf("read OAuth signing key: %w", err)
	}

	key, err := rsa.GenerateKey(rand.Reader, 2048)
	if err != nil {
		return nil, fmt.Errorf("generate OAuth signing key: %w", err)
	}
	encoded, err := x509.MarshalPKCS8PrivateKey(key)
	if err != nil {
		return nil, fmt.Errorf("encode OAuth signing key: %w", err)
	}
	contents = pem.EncodeToMemory(&pem.Block{Type: "PRIVATE KEY", Bytes: encoded})
	directory := filepath.Dir(path)
	if err := os.MkdirAll(directory, 0o700); err != nil {
		return nil, fmt.Errorf("create OAuth key directory: %w", err)
	}
	temp, err := os.CreateTemp(directory, ".oauth-signing-key-*")
	if err != nil {
		return nil, fmt.Errorf("create temporary OAuth signing key: %w", err)
	}
	tempName := temp.Name()
	defer func() { _ = os.Remove(tempName) }()
	if err := temp.Chmod(0o600); err != nil {
		_ = temp.Close()
		return nil, err
	}
	if _, err := temp.Write(contents); err != nil {
		_ = temp.Close()
		return nil, err
	}
	if err := temp.Sync(); err != nil {
		_ = temp.Close()
		return nil, err
	}
	if err := temp.Close(); err != nil {
		return nil, err
	}
	if err := os.Rename(tempName, path); err != nil {
		if existing, readErr := os.ReadFile(path); readErr == nil {
			return parseRSAPrivateKey(existing)
		}
		return nil, fmt.Errorf("persist OAuth signing key: %w", err)
	}
	return key, nil
}

func parseRSAPrivateKey(contents []byte) (*rsa.PrivateKey, error) {
	block, _ := pem.Decode(contents)
	if block == nil {
		return nil, errors.New("OAuth signing key is not PEM")
	}
	key, err := x509.ParsePKCS8PrivateKey(block.Bytes)
	if err != nil {
		return nil, fmt.Errorf("parse OAuth signing key: %w", err)
	}
	rsaKey, ok := key.(*rsa.PrivateKey)
	if !ok {
		return nil, errors.New("OAuth signing key is not RSA")
	}
	if err := rsaKey.Validate(); err != nil {
		return nil, fmt.Errorf("validate OAuth signing key: %w", err)
	}
	return rsaKey, nil
}

func signingKeyID(publicKey *rsa.PublicKey) (string, error) {
	encoded, err := x509.MarshalPKIXPublicKey(publicKey)
	if err != nil {
		return "", err
	}
	digest := sha256.Sum256(encoded)
	return base64.RawURLEncoding.EncodeToString(digest[:12]), nil
}
