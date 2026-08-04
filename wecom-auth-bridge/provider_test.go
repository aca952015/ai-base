package main

import (
	"context"
	"encoding/base64"
	"encoding/json"
	"errors"
	"net/http"
	"net/http/httptest"
	"net/url"
	"path/filepath"
	"strings"
	"testing"
	"time"
)

type staticAuthConfigurationProvider struct {
	configuration wecomAuthConfiguration
	err           error
}

func (p staticAuthConfigurationProvider) Runtime(context.Context) (wecomRuntimeConfig, error) {
	return p.configuration.Runtime, p.err
}

func (p staticAuthConfigurationProvider) Configuration(context.Context) (wecomAuthConfiguration, error) {
	return p.configuration, p.err
}

func testProvider(t *testing.T, apiBase, authorizationURL string) *provider {
	t.Helper()
	directory := t.TempDir()
	cfg := config{
		issuer:               "http://wecom-auth-bridge:8082",
		clientID:             "ai-base-dex",
		clientSecret:         "test-client-secret-with-enough-bytes",
		dexRedirectURI:       "https://dex.example.com/dex/callback",
		authorizationURL:     authorizationURL,
		apiBaseURL:           apiBase,
		signingKeyPath:       filepath.Join(directory, "signing.pem"),
		refreshStorePath:     filepath.Join(directory, "refresh.json"),
		accessTokenLifetime:  time.Hour,
		refreshTokenLifetime: 90 * 24 * time.Hour,
		requestLifetime:      10 * time.Minute,
	}
	signingKey, err := loadOrCreateSigner(cfg.signingKeyPath)
	if err != nil {
		t.Fatal(err)
	}
	refresh, err := loadRefreshStore(cfg.refreshStorePath, cfg.refreshTokenLifetime)
	if err != nil {
		t.Fatal(err)
	}
	return newProvider(
		cfg,
		staticAuthConfigurationProvider{configuration: wecomAuthConfiguration{
			Runtime: wecomRuntimeConfig{
				PublicBaseURL:     "https://auth.example.com/wecom-oidc",
				PublicCallbackURL: "https://auth.example.com/wecom-oidc/callback",
				EmailDomain:       "example.com",
				CookiePath:        "/wecom-oidc",
				SecureCookie:      true,
			},
			Application: integrationCredential{CorpID: "ww-corp", AppSecret: "app-secret"},
		}},
		&wecomClient{apiBase: apiBase, client: http.DefaultClient},
		signingKey,
		refresh,
	)
}

func TestDiscoveryUsesPublicAuthorizationAndInternalBackchannel(t *testing.T) {
	provider := testProvider(t, "https://qyapi.weixin.qq.com", "https://open.weixin.qq.com/connect/oauth2/authorize")
	request := httptest.NewRequest(http.MethodGet, "/.well-known/openid-configuration", nil)
	response := httptest.NewRecorder()
	provider.routes().ServeHTTP(response, request)
	if response.Code != http.StatusOK {
		t.Fatalf("status = %d, body = %s", response.Code, response.Body.String())
	}
	var discovery map[string]any
	if err := json.Unmarshal(response.Body.Bytes(), &discovery); err != nil {
		t.Fatal(err)
	}
	if discovery["issuer"] != provider.cfg.issuer {
		t.Fatalf("issuer = %v", discovery["issuer"])
	}
	if discovery["authorization_endpoint"] != "https://auth.example.com/wecom-oidc/authorize" {
		t.Fatalf("authorization endpoint = %v", discovery["authorization_endpoint"])
	}
	if discovery["token_endpoint"] != provider.cfg.issuer+"/token" {
		t.Fatalf("token endpoint = %v", discovery["token_endpoint"])
	}
}

func TestReadinessRequiresConsoleRuntimeAndActiveIntegration(t *testing.T) {
	provider := testProvider(t, "https://qyapi.weixin.qq.com", "https://open.weixin.qq.com/connect/oauth2/authorize")
	provider.configuration = staticAuthConfigurationProvider{err: errors.New("configuration unavailable")}
	request := httptest.NewRequest(http.MethodGet, "/ready", nil)
	response := httptest.NewRecorder()
	provider.routes().ServeHTTP(response, request)
	if response.Code != http.StatusServiceUnavailable {
		t.Fatalf("status = %d, body = %s", response.Code, response.Body.String())
	}
}

func TestEndToEndAuthorizationCodeAndRefreshFlow(t *testing.T) {
	wecomAPI := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		switch r.URL.Path {
		case "/cgi-bin/gettoken":
			if r.URL.Query().Get("corpid") != "ww-corp" || r.URL.Query().Get("corpsecret") != "app-secret" {
				t.Fatalf("unexpected token query: %s", r.URL.RawQuery)
			}
			_, _ = w.Write([]byte(`{"errcode":0,"access_token":"wecom-access","expires_in":7200}`))
		case "/cgi-bin/auth/getuserinfo":
			if r.URL.Query().Get("code") != "wecom-code" {
				t.Fatalf("unexpected authorization code: %s", r.URL.Query().Get("code"))
			}
			_, _ = w.Write([]byte(`{"errcode":0,"UserId":"zhangsan"}`))
		case "/cgi-bin/user/get":
			_, _ = w.Write([]byte(`{"errcode":0,"userid":"zhangsan","name":"张三","email":"zhangsan@example.com"}`))
		default:
			http.NotFound(w, r)
		}
	}))
	defer wecomAPI.Close()
	provider := testProvider(t, wecomAPI.URL, wecomAPI.URL+"/authorize")

	authorizeURL := "/authorize?" + url.Values{
		"client_id":     {provider.cfg.clientID},
		"redirect_uri":  {provider.cfg.dexRedirectURI},
		"response_type": {"code"},
		"scope":         {"openid profile email groups offline_access"},
		"state":         {"dex-state"},
		"nonce":         {"dex-nonce"},
	}.Encode()
	authorizeRequest := httptest.NewRequest(http.MethodGet, authorizeURL, nil)
	authorizeResponse := httptest.NewRecorder()
	provider.routes().ServeHTTP(authorizeResponse, authorizeRequest)
	if authorizeResponse.Code != http.StatusFound {
		t.Fatalf("authorize status = %d, body = %s", authorizeResponse.Code, authorizeResponse.Body.String())
	}
	wecomLocation, err := url.Parse(authorizeResponse.Header().Get("Location"))
	if err != nil {
		t.Fatal(err)
	}
	if wecomLocation.Query().Get("appid") != "ww-corp" || wecomLocation.Query().Get("scope") != "snsapi_base" {
		t.Fatalf("unexpected WeCom redirect: %s", wecomLocation.String())
	}
	if wecomLocation.Query().Get("redirect_uri") != "https://auth.example.com/wecom-oidc/callback" {
		t.Fatalf("redirect URI = %q", wecomLocation.Query().Get("redirect_uri"))
	}
	state := wecomLocation.Query().Get("state")
	if len(state) != 64 || strings.Trim(state, "0123456789abcdef") != "" {
		t.Fatalf("state must be 64 lowercase hexadecimal characters, got %q", state)
	}
	cookies := authorizeResponse.Result().Cookies()
	if len(cookies) != 1 || cookies[0].Value != state {
		t.Fatalf("state cookie does not match redirect state")
	}
	if !cookies[0].HttpOnly || !cookies[0].Secure || cookies[0].SameSite != http.SameSiteLaxMode || cookies[0].Path != "/wecom-oidc" {
		t.Fatalf("unexpected state cookie attributes: %#v", cookies[0])
	}

	callbackRequest := httptest.NewRequest(http.MethodGet, "/callback?"+url.Values{
		"state": {state},
		"code":  {"wecom-code"},
	}.Encode(), nil)
	callbackRequest.AddCookie(cookies[0])
	callbackResponse := httptest.NewRecorder()
	provider.routes().ServeHTTP(callbackResponse, callbackRequest)
	if callbackResponse.Code != http.StatusFound {
		t.Fatalf("callback status = %d, body = %s", callbackResponse.Code, callbackResponse.Body.String())
	}
	dexLocation, _ := url.Parse(callbackResponse.Header().Get("Location"))
	if dexLocation.Query().Get("state") != "dex-state" || dexLocation.Query().Get("code") == "" {
		t.Fatalf("unexpected Dex redirect: %s", dexLocation.String())
	}

	tokenForm := url.Values{
		"grant_type":   {"authorization_code"},
		"code":         {dexLocation.Query().Get("code")},
		"redirect_uri": {provider.cfg.dexRedirectURI},
	}
	tokenRequest := httptest.NewRequest(http.MethodPost, "/token", strings.NewReader(tokenForm.Encode()))
	tokenRequest.Header.Set("Content-Type", "application/x-www-form-urlencoded")
	tokenRequest.SetBasicAuth(provider.cfg.clientID, provider.cfg.clientSecret)
	tokenResponse := httptest.NewRecorder()
	provider.routes().ServeHTTP(tokenResponse, tokenRequest)
	if tokenResponse.Code != http.StatusOK {
		t.Fatalf("token status = %d, body = %s", tokenResponse.Code, tokenResponse.Body.String())
	}
	var tokens map[string]any
	if err := json.Unmarshal(tokenResponse.Body.Bytes(), &tokens); err != nil {
		t.Fatal(err)
	}
	if tokens["access_token"] == "" || tokens["refresh_token"] == "" || tokens["id_token"] == "" {
		t.Fatalf("incomplete token response: %#v", tokens)
	}
	parts := strings.Split(tokens["id_token"].(string), ".")
	if len(parts) != 3 {
		t.Fatalf("invalid ID token")
	}
	claimsJSON, err := base64.RawURLEncoding.DecodeString(parts[1])
	if err != nil {
		t.Fatal(err)
	}
	var claims map[string]any
	if err := json.Unmarshal(claimsJSON, &claims); err != nil {
		t.Fatal(err)
	}
	if claims["email"] != "zhangsan@example.com" || claims["nonce"] != "dex-nonce" {
		t.Fatalf("unexpected claims: %#v", claims)
	}

	userinfoRequest := httptest.NewRequest(http.MethodGet, "/userinfo", nil)
	userinfoRequest.Header.Set("Authorization", "Bearer "+tokens["access_token"].(string))
	userinfoResponse := httptest.NewRecorder()
	provider.routes().ServeHTTP(userinfoResponse, userinfoRequest)
	if userinfoResponse.Code != http.StatusOK || !strings.Contains(userinfoResponse.Body.String(), "zhangsan@example.com") {
		t.Fatalf("userinfo status = %d, body = %s", userinfoResponse.Code, userinfoResponse.Body.String())
	}

	refreshForm := url.Values{
		"grant_type":    {"refresh_token"},
		"refresh_token": {tokens["refresh_token"].(string)},
	}
	refreshRequest := httptest.NewRequest(http.MethodPost, "/token", strings.NewReader(refreshForm.Encode()))
	refreshRequest.Header.Set("Content-Type", "application/x-www-form-urlencoded")
	refreshRequest.SetBasicAuth(provider.cfg.clientID, provider.cfg.clientSecret)
	refreshResponse := httptest.NewRecorder()
	provider.routes().ServeHTTP(refreshResponse, refreshRequest)
	if refreshResponse.Code != http.StatusOK {
		t.Fatalf("refresh status = %d, body = %s", refreshResponse.Code, refreshResponse.Body.String())
	}
}

func TestTokenEndpointRejectsMissingClientSecret(t *testing.T) {
	provider := testProvider(t, "https://qyapi.weixin.qq.com", "https://open.weixin.qq.com/connect/oauth2/authorize")
	request := httptest.NewRequest(http.MethodPost, "/token", strings.NewReader("grant_type=refresh_token&client_id=ai-base-dex"))
	request.Header.Set("Content-Type", "application/x-www-form-urlencoded")
	response := httptest.NewRecorder()
	provider.routes().ServeHTTP(response, request)
	if response.Code != http.StatusUnauthorized {
		t.Fatalf("status = %d, body = %s", response.Code, response.Body.String())
	}
}
