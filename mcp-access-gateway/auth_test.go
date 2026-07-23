package main

import (
	"context"
	"crypto/rand"
	"crypto/rsa"
	"encoding/base64"
	"encoding/json"
	"errors"
	"math/big"
	"net/http"
	"net/http/httptest"
	"testing"
	"time"

	"github.com/go-jose/go-jose/v4"
)

func TestOIDCVerifierValidatesAudienceAndScope(t *testing.T) {
	privateKey, err := rsa.GenerateKey(rand.Reader, 2048)
	if err != nil {
		t.Fatal(err)
	}

	var provider *httptest.Server
	provider = httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		switch r.URL.Path {
		case "/.well-known/openid-configuration":
			writeJSON(w, http.StatusOK, map[string]interface{}{
				"issuer":                                provider.URL,
				"jwks_uri":                              provider.URL + "/keys",
				"authorization_endpoint":                provider.URL + "/authorize",
				"token_endpoint":                        provider.URL + "/token",
				"response_types_supported":              []string{"code"},
				"subject_types_supported":               []string{"public"},
				"id_token_signing_alg_values_supported": []string{"RS256"},
			})
		case "/keys":
			writeJSON(w, http.StatusOK, map[string]interface{}{
				"keys": []map[string]string{{
					"kty": "RSA",
					"kid": "test-key",
					"use": "sig",
					"alg": "RS256",
					"n":   base64.RawURLEncoding.EncodeToString(privateKey.PublicKey.N.Bytes()),
					"e":   base64.RawURLEncoding.EncodeToString(big.NewInt(int64(privateKey.PublicKey.E)).Bytes()),
				}},
			})
		default:
			http.NotFound(w, r)
		}
	}))
	defer provider.Close()

	cfg := config{
		issuer:         provider.URL,
		audience:       "https://mcp.example/mcp",
		requiredScopes: []string{"ai-base:mcp"},
	}
	verifier := newOIDCTokenVerifier(cfg)

	validToken := signTestToken(t, privateKey, map[string]interface{}{
		"iss":   provider.URL,
		"sub":   "employee-123",
		"aud":   "https://mcp.example/mcp",
		"azp":   "workbuddy",
		"scope": "openid ai-base:mcp",
		"iat":   time.Now().Add(-time.Minute).Unix(),
		"exp":   time.Now().Add(time.Hour).Unix(),
	})
	caller, err := verifier.verify(context.Background(), validToken)
	if err != nil {
		t.Fatal(err)
	}
	if caller.subject != "employee-123" || caller.clientID != "workbuddy" {
		t.Fatalf("unexpected identity: %#v", caller)
	}

	wrongScope := signTestToken(t, privateKey, map[string]interface{}{
		"iss":   provider.URL,
		"sub":   "employee-123",
		"aud":   "https://mcp.example/mcp",
		"scope": "openid",
		"iat":   time.Now().Add(-time.Minute).Unix(),
		"exp":   time.Now().Add(time.Hour).Unix(),
	})
	if _, err := verifier.verify(context.Background(), wrongScope); !errors.Is(err, errInsufficientScope) {
		t.Fatalf("expected insufficient scope, got %v", err)
	}
}

func signTestToken(t *testing.T, privateKey *rsa.PrivateKey, claims map[string]interface{}) string {
	t.Helper()
	signer, err := jose.NewSigner(
		jose.SigningKey{Algorithm: jose.RS256, Key: privateKey},
		&jose.SignerOptions{ExtraHeaders: map[jose.HeaderKey]interface{}{
			jose.HeaderKey("kid"): "test-key",
			jose.HeaderKey("typ"): "at+jwt",
		}},
	)
	if err != nil {
		t.Fatal(err)
	}
	payload, err := json.Marshal(claims)
	if err != nil {
		t.Fatal(err)
	}
	object, err := signer.Sign(payload)
	if err != nil {
		t.Fatal(err)
	}
	serialized, err := object.CompactSerialize()
	if err != nil {
		t.Fatal(err)
	}
	return serialized
}
