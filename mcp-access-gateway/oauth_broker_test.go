package main

import (
	"context"
	"crypto/rand"
	"crypto/rsa"
	"crypto/sha256"
	"encoding/base64"
	"encoding/hex"
	"encoding/json"
	"errors"
	"net/http"
	"net/http/httptest"
	"net/url"
	"os"
	"strings"
	"testing"
	"time"

	"github.com/go-jose/go-jose/v4"
)

const workBuddyRedirectURI = "workbuddy://workbuddy/mcp/custom-mcp%3Aai-base/oauth/callback"

type fakeLoginProvider struct {
	nonce string
}

func (p *fakeLoginProvider) authorizationURL(state, nonce, codeVerifier string) string {
	p.nonce = nonce
	values := url.Values{
		"state":         {state},
		"nonce":         {nonce},
		"code_verifier": {codeVerifier},
	}
	return "https://dex.example/auth?" + values.Encode()
}

func (p *fakeLoginProvider) exchange(
	_ context.Context,
	code string,
	_ string,
	expectedNonce string,
) (employeeIdentity, error) {
	if code != "dex-code" || expectedNonce == "" || expectedNonce != p.nonce {
		return employeeIdentity{}, errors.New("invalid upstream login")
	}
	return employeeIdentity{
		Subject:         "dex-user-123",
		Email:           "employee@example.com",
		Name:            "Example Employee",
		Groups:          []string{"engineering", "wecom:012345abcdef"},
		WeComUserIDHash: deriveWeComUserIDHash("zhangsan", []string{"engineering", "wecom:012345abcdef"}),
	}, nil
}

func brokerTestConfig(t *testing.T) config {
	t.Helper()
	cfg := testConfig(t, "http://127.0.0.1:1/mcp")
	cfg.resourceURL = "https://mcp.example/mcp"
	cfg.metadataURL = "https://mcp.example/.well-known/oauth-protected-resource/mcp"
	cfg.issuer = "https://mcp.example/oauth"
	cfg.audience = cfg.resourceURL
	cfg.loginIssuer = "https://dex.example/dex"
	cfg.loginClientID = "ai-base-mcp-broker"
	cfg.loginRedirectURL = cfg.issuer + "/callback"
	cfg.allowedRedirectURIs = []string{workBuddyRedirectURI}
	cfg.accessTokenLifetime = time.Hour
	cfg.refreshTokenLifetime = 8 * time.Hour
	cfg.authorizationCodeLifetime = 5 * time.Minute
	cfg.loginTransactionLifetime = 10 * time.Minute
	return cfg
}

func newBrokerForTest(t *testing.T) (*oauthBroker, *fakeLoginProvider) {
	t.Helper()
	key, err := rsa.GenerateKey(rand.Reader, 2048)
	if err != nil {
		t.Fatal(err)
	}
	login := &fakeLoginProvider{}
	broker, err := newOAuthBrokerWithKey(brokerTestConfig(t), login, key)
	if err != nil {
		t.Fatal(err)
	}
	return broker, login
}

func TestDynamicClientRegistrationRestrictsRedirects(t *testing.T) {
	broker, _ := newBrokerForTest(t)

	for _, testCase := range []struct {
		name       string
		redirect   string
		wantStatus int
	}{
		{
			name:       "configured WorkBuddy callback",
			redirect:   workBuddyRedirectURI,
			wantStatus: http.StatusCreated,
		},
		{
			name:       "native loopback callback",
			redirect:   "http://127.0.0.1:49152/callback",
			wantStatus: http.StatusCreated,
		},
		{
			name:       "unregistered WorkBuddy callback",
			redirect:   "workbuddy://workbuddy/mcp/attacker/oauth/callback",
			wantStatus: http.StatusBadRequest,
		},
		{
			name:       "remote HTTP callback",
			redirect:   "http://attacker.example/callback",
			wantStatus: http.StatusBadRequest,
		},
	} {
		t.Run(testCase.name, func(t *testing.T) {
			body := `{"redirect_uris":[` + quoted(testCase.redirect) + `],"token_endpoint_auth_method":"none"}`
			request := httptest.NewRequest(http.MethodPost, "/oauth/register", strings.NewReader(body))
			response := httptest.NewRecorder()
			broker.registerClient(response, request)
			if response.Code != testCase.wantStatus {
				t.Fatalf("expected %d, got %d: %s", testCase.wantStatus, response.Code, response.Body.String())
			}
		})
	}
}

func TestAuthorizationCodeFlowAndReusableRefresh(t *testing.T) {
	broker, _ := newBrokerForTest(t)
	clientID := registerWorkBuddyClient(t, broker)
	verifier := strings.Repeat("v", 64)
	digest := sha256.Sum256([]byte(verifier))
	challenge := base64.RawURLEncoding.EncodeToString(digest[:])

	authorizeQuery := url.Values{
		"response_type":         {"code"},
		"client_id":             {clientID},
		"redirect_uri":          {workBuddyRedirectURI},
		"state":                 {"workbuddy-state"},
		"scope":                 {"ai-base:mcp offline_access"},
		"resource":              {broker.cfg.resourceURL},
		"code_challenge":        {challenge},
		"code_challenge_method": {"S256"},
	}
	authorizeRequest := httptest.NewRequest(
		http.MethodGet,
		"/oauth/authorize?"+authorizeQuery.Encode(),
		nil,
	)
	authorizeResponse := httptest.NewRecorder()
	broker.authorize(authorizeResponse, authorizeRequest)
	if authorizeResponse.Code != http.StatusFound {
		t.Fatalf("expected login redirect, got %d: %s", authorizeResponse.Code, authorizeResponse.Body.String())
	}
	loginURL, err := url.Parse(authorizeResponse.Header().Get("Location"))
	if err != nil {
		t.Fatal(err)
	}

	callbackQuery := url.Values{
		"state": {loginURL.Query().Get("state")},
		"code":  {"dex-code"},
	}
	callbackRequest := httptest.NewRequest(
		http.MethodGet,
		"/oauth/callback?"+callbackQuery.Encode(),
		nil,
	)
	callbackResponse := httptest.NewRecorder()
	broker.loginCallback(callbackResponse, callbackRequest)
	if callbackResponse.Code != http.StatusFound {
		t.Fatalf("expected WorkBuddy redirect, got %d: %s", callbackResponse.Code, callbackResponse.Body.String())
	}
	workBuddyURL, err := url.Parse(callbackResponse.Header().Get("Location"))
	if err != nil {
		t.Fatal(err)
	}
	if workBuddyURL.Scheme != "workbuddy" || workBuddyURL.Query().Get("state") != "workbuddy-state" {
		t.Fatalf("unexpected callback redirect: %s", workBuddyURL)
	}

	token := exchangeCodeForToken(
		t,
		broker,
		clientID,
		workBuddyURL.Query().Get("code"),
		verifier,
	)
	assertAccessToken(t, broker, token.AccessToken, clientID)
	if token.RefreshToken == "" {
		t.Fatal("expected refresh token")
	}

	refreshed := refreshAccessToken(t, broker, clientID, token.RefreshToken, http.StatusOK)
	if refreshed.RefreshToken != token.RefreshToken {
		t.Fatal("refresh response did not preserve the reusable refresh token")
	}
	assertAccessToken(t, broker, refreshed.AccessToken, clientID)
	refreshAccessToken(t, broker, clientID, token.RefreshToken, http.StatusOK)
}

func TestDeriveWeComUserIDHashRequiresOneTrustedEnterpriseMarker(t *testing.T) {
	digest := sha256.Sum256([]byte("zhangsan"))
	want := hex.EncodeToString(digest[:])

	for _, testCase := range []struct {
		name              string
		preferredUsername string
		groups            []string
		want              string
	}{
		{
			name:              "verified WeCom identity",
			preferredUsername: "zhangsan",
			groups:            []string{"employees", "wecom:012345abcdef"},
			want:              want,
		},
		{
			name:              "missing preferred username",
			preferredUsername: " ",
			groups:            []string{"wecom:012345abcdef"},
		},
		{
			name:              "missing enterprise marker",
			preferredUsername: "zhangsan",
			groups:            []string{"employees"},
		},
		{
			name:              "uppercase marker is not trusted",
			preferredUsername: "zhangsan",
			groups:            []string{"wecom:012345ABCDEf"},
		},
		{
			name:              "short marker is not trusted",
			preferredUsername: "zhangsan",
			groups:            []string{"wecom:012345abcde"},
		},
		{
			name:              "ambiguous enterprise markers",
			preferredUsername: "zhangsan",
			groups:            []string{"wecom:012345abcdef", "wecom:fedcba654321"},
		},
	} {
		t.Run(testCase.name, func(t *testing.T) {
			if got := deriveWeComUserIDHash(testCase.preferredUsername, testCase.groups); got != testCase.want {
				t.Fatalf("expected %q, got %q", testCase.want, got)
			}
		})
	}
}

func TestRefreshTokenPersistsAndSlidesAcrossBrokerRestarts(t *testing.T) {
	cfg := brokerTestConfig(t)
	cfg.refreshTokenLifetime = 2160 * time.Hour
	cfg.oauthRefreshStorePath = t.TempDir() + "/oauth-refresh-grants.json"
	key, err := rsa.GenerateKey(rand.Reader, 2048)
	if err != nil {
		t.Fatal(err)
	}
	login := &fakeLoginProvider{}
	employee := employeeIdentity{
		Subject: "persistent-employee",
		Email:   "employee@example.com",
		Name:    "Example Employee",
	}
	clientID := clientIDForRedirectURI(workBuddyRedirectURI)

	firstBroker, err := newOAuthBrokerWithKey(cfg, login, key)
	if err != nil {
		t.Fatal(err)
	}
	firstToken, err := firstBroker.issueRefreshToken(
		employee,
		clientID,
		"ai-base:mcp offline_access",
		cfg.resourceURL,
	)
	if err != nil {
		t.Fatal(err)
	}
	storedGrant := firstBroker.refresh[refreshTokenHash(firstToken)]
	if remaining := time.Until(storedGrant.ExpiresAt); remaining < 2159*time.Hour {
		t.Fatalf("expected an employee-friendly refresh lifetime, got %s", remaining)
	}
	contents, err := os.ReadFile(cfg.oauthRefreshStorePath)
	if err != nil {
		t.Fatal(err)
	}
	if strings.Contains(string(contents), firstToken) {
		t.Fatal("refresh grant store must contain only token hashes")
	}
	info, err := os.Stat(cfg.oauthRefreshStorePath)
	if err != nil {
		t.Fatal(err)
	}
	if info.Mode().Perm() != 0o600 {
		t.Fatalf("refresh grant store must use 0600 permissions, got %o", info.Mode().Perm())
	}

	secondBroker, err := newOAuthBrokerWithKey(cfg, login, key)
	if err != nil {
		t.Fatal(err)
	}
	initialExpiry := secondBroker.refresh[refreshTokenHash(firstToken)].ExpiresAt
	secondBroker.now = func() time.Time {
		return initialExpiry.Add(-time.Hour)
	}
	refreshed := refreshAccessToken(t, secondBroker, clientID, firstToken, http.StatusOK)
	if refreshed.RefreshToken != firstToken {
		t.Fatal("persisted refresh token changed after restart")
	}
	slidingExpiry := secondBroker.refresh[refreshTokenHash(firstToken)].ExpiresAt
	if !slidingExpiry.After(initialExpiry) {
		t.Fatalf("refresh token expiry did not slide forward: initial=%s renewed=%s", initialExpiry, slidingExpiry)
	}

	thirdBroker, err := newOAuthBrokerWithKey(cfg, login, key)
	if err != nil {
		t.Fatal(err)
	}
	refreshAccessToken(t, thirdBroker, clientID, firstToken, http.StatusOK)
}

func TestAuthorizationCodeIsSingleUseAfterPKCEFailure(t *testing.T) {
	broker, _ := newBrokerForTest(t)
	clientID := clientIDForRedirectURI(workBuddyRedirectURI)
	verifier := strings.Repeat("a", 64)
	digest := sha256.Sum256([]byte(verifier))
	code := "one-time-code"
	broker.codes[code] = authorizationCode{
		ClientID:      clientID,
		RedirectURI:   workBuddyRedirectURI,
		CodeChallenge: base64.RawURLEncoding.EncodeToString(digest[:]),
		Scope:         "ai-base:mcp",
		Resource:      broker.cfg.resourceURL,
		Employee:      employeeIdentity{Subject: "employee"},
		ExpiresAt:     time.Now().Add(time.Minute),
	}

	for _, suppliedVerifier := range []string{strings.Repeat("b", 64), verifier} {
		form := url.Values{
			"grant_type":    {"authorization_code"},
			"client_id":     {clientID},
			"redirect_uri":  {workBuddyRedirectURI},
			"code":          {code},
			"code_verifier": {suppliedVerifier},
		}
		request := httptest.NewRequest(
			http.MethodPost,
			"/oauth/token",
			strings.NewReader(form.Encode()),
		)
		request.Header.Set("Content-Type", "application/x-www-form-urlencoded")
		response := httptest.NewRecorder()
		broker.token(response, request)
		if response.Code != http.StatusBadRequest {
			t.Fatalf("expected rejected one-time code, got %d", response.Code)
		}
	}
}

type tokenResponse struct {
	AccessToken  string `json:"access_token"`
	RefreshToken string `json:"refresh_token"`
}

func registerWorkBuddyClient(t *testing.T, broker *oauthBroker) string {
	t.Helper()
	body := `{
		"client_name":"WorkBuddy",
		"redirect_uris":[` + quoted(workBuddyRedirectURI) + `],
		"token_endpoint_auth_method":"none",
		"grant_types":["authorization_code","refresh_token"],
		"response_types":["code"]
	}`
	request := httptest.NewRequest(http.MethodPost, "/oauth/register", strings.NewReader(body))
	response := httptest.NewRecorder()
	broker.registerClient(response, request)
	if response.Code != http.StatusCreated {
		t.Fatalf("registration failed: %d %s", response.Code, response.Body.String())
	}
	var result struct {
		ClientID string `json:"client_id"`
	}
	if err := json.NewDecoder(response.Body).Decode(&result); err != nil {
		t.Fatal(err)
	}
	return result.ClientID
}

func exchangeCodeForToken(
	t *testing.T,
	broker *oauthBroker,
	clientID string,
	code string,
	verifier string,
) tokenResponse {
	t.Helper()
	form := url.Values{
		"grant_type":    {"authorization_code"},
		"client_id":     {clientID},
		"redirect_uri":  {workBuddyRedirectURI},
		"code":          {code},
		"code_verifier": {verifier},
		"resource":      {broker.cfg.resourceURL},
	}
	request := httptest.NewRequest(http.MethodPost, "/oauth/token", strings.NewReader(form.Encode()))
	request.Header.Set("Content-Type", "application/x-www-form-urlencoded")
	response := httptest.NewRecorder()
	broker.token(response, request)
	if response.Code != http.StatusOK {
		t.Fatalf("token exchange failed: %d %s", response.Code, response.Body.String())
	}
	var result tokenResponse
	if err := json.NewDecoder(response.Body).Decode(&result); err != nil {
		t.Fatal(err)
	}
	return result
}

func refreshAccessToken(
	t *testing.T,
	broker *oauthBroker,
	clientID string,
	refreshToken string,
	wantStatus int,
) tokenResponse {
	t.Helper()
	form := url.Values{
		"grant_type":    {"refresh_token"},
		"client_id":     {clientID},
		"refresh_token": {refreshToken},
	}
	request := httptest.NewRequest(http.MethodPost, "/oauth/token", strings.NewReader(form.Encode()))
	request.Header.Set("Content-Type", "application/x-www-form-urlencoded")
	response := httptest.NewRecorder()
	broker.token(response, request)
	if response.Code != wantStatus {
		t.Fatalf("expected refresh status %d, got %d: %s", wantStatus, response.Code, response.Body.String())
	}
	var result tokenResponse
	if response.Code == http.StatusOK {
		if err := json.NewDecoder(response.Body).Decode(&result); err != nil {
			t.Fatal(err)
		}
	}
	return result
}

func assertAccessToken(t *testing.T, broker *oauthBroker, rawToken, clientID string) {
	t.Helper()
	object, err := jose.ParseSigned(rawToken, []jose.SignatureAlgorithm{jose.RS256})
	if err != nil {
		t.Fatal(err)
	}
	payload, err := object.Verify(&broker.signingKey.PublicKey)
	if err != nil {
		t.Fatal(err)
	}
	var claims map[string]interface{}
	if err := json.Unmarshal(payload, &claims); err != nil {
		t.Fatal(err)
	}
	if claims["iss"] != broker.cfg.issuer ||
		claims["aud"] != broker.cfg.resourceURL ||
		claims["client_id"] != clientID ||
		claims["sub"] != brokerSubject(broker.cfg.loginIssuer, "dex-user-123") {
		t.Fatalf("unexpected access token claims: %#v", claims)
	}
	expectedDigest := sha256.Sum256([]byte("zhangsan"))
	if claims["wecom_user_id_hash"] != hex.EncodeToString(expectedDigest[:]) {
		t.Fatalf("access token did not preserve the verified WeCom identity hash: %#v", claims)
	}
	if _, exists := claims["preferred_username"]; exists {
		t.Fatalf("access token must not contain the plaintext WeCom UserID: %#v", claims)
	}
}

func quoted(value string) string {
	encoded, _ := json.Marshal(value)
	return string(encoded)
}
