package main

import (
	"context"
	"crypto/sha256"
	"encoding/base64"
	"encoding/hex"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"net/http"
	"net/url"
	"regexp"
	"strings"
	"sync"
	"time"
)

type integrationCredential struct {
	ID        string `json:"id"`
	Name      string `json:"name"`
	CorpID    string `json:"corpId"`
	AppSecret string `json:"appSecret"`
	UpdatedAt string `json:"updatedAt"`
}

type integrationConfigResponse struct {
	Configured  bool                  `json:"configured"`
	Application integrationCredential `json:"application"`
	Error       string                `json:"error"`
}

type credentialProvider interface {
	Credential(context.Context) (integrationCredential, error)
}

type remoteCredentialProvider struct {
	url     string
	token   string
	client  *http.Client
	mu      sync.Mutex
	cached  integrationCredential
	expires time.Time
}

func (p *remoteCredentialProvider) Credential(ctx context.Context) (integrationCredential, error) {
	p.mu.Lock()
	if p.cached.CorpID != "" && time.Now().Before(p.expires) {
		credential := p.cached
		p.mu.Unlock()
		return credential, nil
	}
	p.mu.Unlock()

	req, err := http.NewRequestWithContext(ctx, http.MethodGet, p.url, nil)
	if err != nil {
		return integrationCredential{}, err
	}
	req.Header.Set("Authorization", "Bearer "+p.token)
	req.Header.Set("Accept", "application/json")
	response, err := p.client.Do(req)
	if err != nil {
		return integrationCredential{}, fmt.Errorf("read active WeCom integration: %w", err)
	}
	defer response.Body.Close()
	body, err := io.ReadAll(io.LimitReader(response.Body, 1<<20))
	if err != nil {
		return integrationCredential{}, err
	}
	var payload integrationConfigResponse
	if err := json.Unmarshal(body, &payload); err != nil {
		return integrationCredential{}, errors.New("AI Console returned invalid integration configuration")
	}
	if response.StatusCode != http.StatusOK || !payload.Configured {
		if payload.Error == "" {
			payload.Error = "WeCom integration is not configured"
		}
		return integrationCredential{}, errors.New(payload.Error)
	}
	if strings.TrimSpace(payload.Application.CorpID) == "" || strings.TrimSpace(payload.Application.AppSecret) == "" {
		return integrationCredential{}, errors.New("active WeCom integration is incomplete")
	}
	p.mu.Lock()
	p.cached = payload.Application
	p.expires = time.Now().Add(2 * time.Minute)
	p.mu.Unlock()
	return payload.Application, nil
}

type identity struct {
	Subject           string   `json:"subject"`
	Email             string   `json:"email"`
	Name              string   `json:"name"`
	PreferredUsername string   `json:"preferred_username"`
	Groups            []string `json:"groups"`
}

type wecomClient struct {
	apiBase      string
	client       *http.Client
	mu           sync.Mutex
	token        string
	tokenKey     string
	tokenExpires time.Time
}

type wecomAPIError struct {
	ErrCode int    `json:"errcode"`
	ErrMsg  string `json:"errmsg"`
}

type accessTokenResponse struct {
	wecomAPIError
	AccessToken string `json:"access_token"`
	ExpiresIn   int    `json:"expires_in"`
}

type userInfoResponse struct {
	wecomAPIError
	UserID string `json:"UserId"`
	OpenID string `json:"OpenId"`
}

type memberResponse struct {
	wecomAPIError
	UserID  string `json:"userid"`
	Name    string `json:"name"`
	Email   string `json:"email"`
	BizMail string `json:"biz_mail"`
}

func (c *wecomClient) exchange(ctx context.Context, credential integrationCredential, code, emailDomain string) (identity, error) {
	token, err := c.accessToken(ctx, credential)
	if err != nil {
		return identity{}, err
	}
	var user userInfoResponse
	if err := c.getJSON(ctx, "/cgi-bin/auth/getuserinfo", url.Values{
		"access_token": {token},
		"code":         {code},
	}, &user); err != nil {
		return identity{}, err
	}
	if user.ErrCode != 0 {
		return identity{}, fmt.Errorf("WeCom getuserinfo failed: %d %s", user.ErrCode, user.ErrMsg)
	}
	if strings.TrimSpace(user.UserID) == "" {
		return identity{}, errors.New("WeCom authorization did not return an enterprise UserID")
	}

	member := memberResponse{}
	_ = c.getJSON(ctx, "/cgi-bin/user/get", url.Values{
		"access_token": {token},
		"userid":       {user.UserID},
	}, &member)
	name := strings.TrimSpace(member.Name)
	if member.ErrCode != 0 || name == "" {
		name = user.UserID
	}
	email := strings.ToLower(strings.TrimSpace(member.Email))
	if email == "" {
		email = strings.ToLower(strings.TrimSpace(member.BizMail))
	}
	if email == "" || !strings.HasSuffix(email, "@"+emailDomain) {
		email = emailLocalPart(user.UserID) + "@" + emailDomain
	}
	subjectDigest := sha256.Sum256([]byte(credential.CorpID + "\x00" + user.UserID))
	corpDigest := sha256.Sum256([]byte(credential.CorpID))
	return identity{
		Subject:           base64.RawURLEncoding.EncodeToString(subjectDigest[:]),
		Email:             email,
		Name:              name,
		PreferredUsername: user.UserID,
		Groups:            []string{"employees", "wecom:" + hex.EncodeToString(corpDigest[:6])},
	}, nil
}

func (c *wecomClient) accessToken(ctx context.Context, credential integrationCredential) (string, error) {
	keyDigest := sha256.Sum256([]byte(credential.CorpID + "\x00" + credential.AppSecret))
	key := hex.EncodeToString(keyDigest[:])
	c.mu.Lock()
	if c.token != "" && c.tokenKey == key && time.Now().Before(c.tokenExpires) {
		token := c.token
		c.mu.Unlock()
		return token, nil
	}
	c.mu.Unlock()
	var response accessTokenResponse
	if err := c.getJSON(ctx, "/cgi-bin/gettoken", url.Values{
		"corpid":     {credential.CorpID},
		"corpsecret": {credential.AppSecret},
	}, &response); err != nil {
		return "", err
	}
	if response.ErrCode != 0 || response.AccessToken == "" {
		return "", fmt.Errorf("WeCom access token failed: %d %s", response.ErrCode, response.ErrMsg)
	}
	lifetime := time.Duration(response.ExpiresIn) * time.Second
	if lifetime <= time.Minute {
		lifetime = 2 * time.Hour
	}
	c.mu.Lock()
	c.token = response.AccessToken
	c.tokenKey = key
	c.tokenExpires = time.Now().Add(lifetime - time.Minute)
	c.mu.Unlock()
	return response.AccessToken, nil
}

func (c *wecomClient) getJSON(ctx context.Context, path string, query url.Values, target any) error {
	endpoint := c.apiBase + path + "?" + query.Encode()
	req, err := http.NewRequestWithContext(ctx, http.MethodGet, endpoint, nil)
	if err != nil {
		return err
	}
	req.Header.Set("Accept", "application/json")
	response, err := c.client.Do(req)
	if err != nil {
		return fmt.Errorf("call WeCom API: %w", err)
	}
	defer response.Body.Close()
	if response.StatusCode != http.StatusOK {
		return fmt.Errorf("WeCom API returned HTTP %d", response.StatusCode)
	}
	decoder := json.NewDecoder(io.LimitReader(response.Body, 1<<20))
	if err := decoder.Decode(target); err != nil {
		return errors.New("WeCom API returned invalid JSON")
	}
	return nil
}

var invalidEmailLocal = regexp.MustCompile(`[^a-z0-9._-]+`)

func emailLocalPart(userID string) string {
	normalized := strings.ToLower(strings.TrimSpace(userID))
	local := invalidEmailLocal.ReplaceAllString(normalized, "-")
	local = strings.Trim(local, ".-_")
	if local != "" && local == normalized {
		return local
	}
	digest := sha256.Sum256([]byte(userID))
	if local != "" {
		return local + "-" + hex.EncodeToString(digest[:4])
	}
	return "wecom-" + hex.EncodeToString(digest[:6])
}
