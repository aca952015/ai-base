package main

import (
	"context"
	"crypto/sha256"
	"errors"
	"fmt"
	"net/http"
	"strings"
	"sync"
	"time"

	"github.com/coreos/go-oidc/v3/oidc"
)

var (
	errMissingToken      = errors.New("missing bearer token")
	errInvalidToken      = errors.New("invalid bearer token")
	errInsufficientScope = errors.New("insufficient scope")
)

type identity struct {
	issuer          string
	subject         string
	clientID        string
	displayName     string
	email           string
	groups          []string
	wecomUserIDHash string
}

type tokenVerifier interface {
	verify(context.Context, string) (identity, error)
}

type oidcTokenVerifier struct {
	issuer         string
	jwksURL        string
	audience       string
	requiredScopes []string
	httpClient     *http.Client

	mu       sync.Mutex
	verifier *oidc.IDTokenVerifier
}

func newOIDCTokenVerifier(cfg config) *oidcTokenVerifier {
	return &oidcTokenVerifier{
		issuer:         cfg.issuer,
		jwksURL:        cfg.jwksURL,
		audience:       cfg.audience,
		requiredScopes: cfg.requiredScopes,
		httpClient:     &http.Client{Timeout: 10 * time.Second},
	}
}

func (v *oidcTokenVerifier) verify(ctx context.Context, rawToken string) (identity, error) {
	verifier, err := v.getVerifier(ctx)
	if err != nil {
		return identity{}, fmt.Errorf("%w: OIDC discovery failed", errInvalidToken)
	}

	token, err := verifier.Verify(ctx, rawToken)
	if err != nil {
		return identity{}, errInvalidToken
	}

	var claims struct {
		AuthorizedParty string      `json:"azp"`
		ClientID        string      `json:"client_id"`
		Email           string      `json:"email"`
		Name            string      `json:"name"`
		Groups          []string    `json:"groups"`
		WeComUserIDHash string      `json:"wecom_user_id_hash"`
		Scope           interface{} `json:"scope"`
		Scopes          interface{} `json:"scp"`
	}
	if err := token.Claims(&claims); err != nil || token.Subject == "" {
		return identity{}, errInvalidToken
	}
	if claims.WeComUserIDHash != "" && !validLowerHex(claims.WeComUserIDHash, sha256.Size*2) {
		return identity{}, errInvalidToken
	}

	grantedScopes := readScopes(claims.Scope)
	for scope := range readScopes(claims.Scopes) {
		grantedScopes[scope] = struct{}{}
	}
	for _, required := range v.requiredScopes {
		if _, ok := grantedScopes[required]; !ok {
			return identity{}, errInsufficientScope
		}
	}

	clientID := claims.AuthorizedParty
	if clientID == "" {
		clientID = claims.ClientID
	}

	return identity{
		issuer:          token.Issuer,
		subject:         token.Subject,
		clientID:        clientID,
		displayName:     claims.Name,
		email:           claims.Email,
		groups:          append([]string(nil), claims.Groups...),
		wecomUserIDHash: claims.WeComUserIDHash,
	}, nil
}

func validLowerHex(value string, length int) bool {
	if len(value) != length {
		return false
	}
	for _, character := range value {
		if (character < '0' || character > '9') && (character < 'a' || character > 'f') {
			return false
		}
	}
	return true
}

func (v *oidcTokenVerifier) getVerifier(ctx context.Context) (*oidc.IDTokenVerifier, error) {
	v.mu.Lock()
	defer v.mu.Unlock()

	if v.verifier != nil {
		return v.verifier, nil
	}

	if v.jwksURL != "" {
		keySet := oidc.NewRemoteKeySet(oidc.ClientContext(ctx, v.httpClient), v.jwksURL)
		v.verifier = oidc.NewVerifier(v.issuer, keySet, &oidc.Config{ClientID: v.audience})
		return v.verifier, nil
	}

	provider, err := oidc.NewProvider(oidc.ClientContext(ctx, v.httpClient), v.issuer)
	if err != nil {
		return nil, err
	}
	v.verifier = provider.Verifier(&oidc.Config{ClientID: v.audience})
	return v.verifier, nil
}

func readScopes(value interface{}) map[string]struct{} {
	scopes := make(map[string]struct{})
	switch typed := value.(type) {
	case string:
		for _, scope := range strings.Fields(typed) {
			scopes[scope] = struct{}{}
		}
	case []interface{}:
		for _, item := range typed {
			if scope, ok := item.(string); ok && scope != "" {
				scopes[scope] = struct{}{}
			}
		}
	}
	return scopes
}

func bearerToken(header string) (string, error) {
	parts := strings.Fields(header)
	if len(parts) != 2 || !strings.EqualFold(parts[0], "Bearer") || parts[1] == "" {
		return "", errMissingToken
	}
	return parts[1], nil
}
