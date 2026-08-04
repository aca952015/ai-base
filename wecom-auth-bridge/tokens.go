package main

import (
	"crypto"
	"crypto/rand"
	"crypto/rsa"
	"crypto/sha256"
	"crypto/x509"
	"encoding/base64"
	"encoding/json"
	"encoding/pem"
	"errors"
	"fmt"
	"os"
	"path/filepath"
	"sync"
	"time"
)

type signer struct {
	privateKey *rsa.PrivateKey
	kid        string
}

func loadOrCreateSigner(path string) (*signer, error) {
	contents, err := os.ReadFile(path)
	if err == nil {
		block, _ := pem.Decode(contents)
		if block == nil {
			return nil, errors.New("OIDC signing key is not PEM")
		}
		key, err := x509.ParsePKCS8PrivateKey(block.Bytes)
		if err != nil {
			return nil, fmt.Errorf("parse OIDC signing key: %w", err)
		}
		privateKey, ok := key.(*rsa.PrivateKey)
		if !ok {
			return nil, errors.New("OIDC signing key is not RSA")
		}
		return newSigner(privateKey), nil
	}
	if !os.IsNotExist(err) {
		return nil, fmt.Errorf("read OIDC signing key: %w", err)
	}
	if err := os.MkdirAll(filepath.Dir(path), 0o700); err != nil {
		return nil, err
	}
	privateKey, err := rsa.GenerateKey(rand.Reader, 2048)
	if err != nil {
		return nil, err
	}
	encoded, err := x509.MarshalPKCS8PrivateKey(privateKey)
	if err != nil {
		return nil, err
	}
	temporary := path + ".tmp"
	if err := os.WriteFile(temporary, pem.EncodeToMemory(&pem.Block{Type: "PRIVATE KEY", Bytes: encoded}), 0o600); err != nil {
		return nil, err
	}
	if err := os.Rename(temporary, path); err != nil {
		return nil, err
	}
	return newSigner(privateKey), nil
}

func newSigner(privateKey *rsa.PrivateKey) *signer {
	der := x509.MarshalPKCS1PublicKey(&privateKey.PublicKey)
	digest := sha256.Sum256(der)
	return &signer{privateKey: privateKey, kid: base64.RawURLEncoding.EncodeToString(digest[:12])}
}

func (s *signer) sign(claims map[string]any) (string, error) {
	header, err := json.Marshal(map[string]string{"alg": "RS256", "kid": s.kid, "typ": "JWT"})
	if err != nil {
		return "", err
	}
	payload, err := json.Marshal(claims)
	if err != nil {
		return "", err
	}
	encodedHeader := base64.RawURLEncoding.EncodeToString(header)
	encodedPayload := base64.RawURLEncoding.EncodeToString(payload)
	input := encodedHeader + "." + encodedPayload
	digest := sha256.Sum256([]byte(input))
	signature, err := rsa.SignPKCS1v15(rand.Reader, s.privateKey, crypto.SHA256, digest[:])
	if err != nil {
		return "", err
	}
	return input + "." + base64.RawURLEncoding.EncodeToString(signature), nil
}

func (s *signer) jwks() map[string]any {
	publicKey := s.privateKey.PublicKey
	return map[string]any{"keys": []map[string]string{{
		"kty": "RSA",
		"use": "sig",
		"alg": "RS256",
		"kid": s.kid,
		"n":   base64.RawURLEncoding.EncodeToString(publicKey.N.Bytes()),
		"e":   base64.RawURLEncoding.EncodeToString([]byte{0x01, 0x00, 0x01}),
	}}}
}

type refreshGrant struct {
	TokenHash string    `json:"token_hash"`
	ClientID  string    `json:"client_id"`
	Identity  identity  `json:"identity"`
	Scope     string    `json:"scope"`
	IssuedAt  time.Time `json:"issued_at"`
	ExpiresAt time.Time `json:"expires_at"`
}

type refreshState struct {
	Version int            `json:"version"`
	Grants  []refreshGrant `json:"grants"`
}

type refreshStore struct {
	mu       sync.Mutex
	path     string
	lifetime time.Duration
	grants   map[string]refreshGrant
}

func loadRefreshStore(path string, lifetime time.Duration) (*refreshStore, error) {
	store := &refreshStore{path: path, lifetime: lifetime, grants: make(map[string]refreshGrant)}
	contents, err := os.ReadFile(path)
	if err != nil {
		if os.IsNotExist(err) {
			return store, nil
		}
		return nil, err
	}
	var state refreshState
	if err := json.Unmarshal(contents, &state); err != nil {
		return nil, fmt.Errorf("parse refresh token store: %w", err)
	}
	now := time.Now()
	for _, grant := range state.Grants {
		if grant.TokenHash != "" && now.Before(grant.ExpiresAt) {
			store.grants[grant.TokenHash] = grant
		}
	}
	return store, nil
}

func (s *refreshStore) issue(clientID string, user identity, scope string) (string, error) {
	raw, err := randomToken(48)
	if err != nil {
		return "", err
	}
	now := time.Now().UTC()
	grant := refreshGrant{
		TokenHash: tokenHash(raw),
		ClientID:  clientID,
		Identity:  user,
		Scope:     scope,
		IssuedAt:  now,
		ExpiresAt: now.Add(s.lifetime),
	}
	s.mu.Lock()
	defer s.mu.Unlock()
	s.grants[grant.TokenHash] = grant
	if err := s.persistLocked(); err != nil {
		delete(s.grants, grant.TokenHash)
		return "", err
	}
	return raw, nil
}

func (s *refreshStore) use(raw, clientID string) (refreshGrant, error) {
	s.mu.Lock()
	defer s.mu.Unlock()
	hash := tokenHash(raw)
	grant, ok := s.grants[hash]
	if !ok || grant.ClientID != clientID || time.Now().After(grant.ExpiresAt) {
		if ok {
			delete(s.grants, hash)
			_ = s.persistLocked()
		}
		return refreshGrant{}, errors.New("invalid refresh token")
	}
	grant.ExpiresAt = time.Now().UTC().Add(s.lifetime)
	s.grants[hash] = grant
	if err := s.persistLocked(); err != nil {
		return refreshGrant{}, err
	}
	return grant, nil
}

func (s *refreshStore) persistLocked() error {
	if err := os.MkdirAll(filepath.Dir(s.path), 0o700); err != nil {
		return err
	}
	now := time.Now()
	grants := make([]refreshGrant, 0, len(s.grants))
	for hash, grant := range s.grants {
		if now.After(grant.ExpiresAt) {
			delete(s.grants, hash)
			continue
		}
		grants = append(grants, grant)
	}
	contents, err := json.MarshalIndent(refreshState{Version: 1, Grants: grants}, "", "  ")
	if err != nil {
		return err
	}
	temporary := s.path + ".tmp"
	if err := os.WriteFile(temporary, contents, 0o600); err != nil {
		return err
	}
	return os.Rename(temporary, s.path)
}

func randomToken(size int) (string, error) {
	buffer := make([]byte, size)
	if _, err := rand.Read(buffer); err != nil {
		return "", err
	}
	return base64.RawURLEncoding.EncodeToString(buffer), nil
}

func randomState() (string, error) {
	buffer := make([]byte, 32)
	if _, err := rand.Read(buffer); err != nil {
		return "", err
	}
	return fmt.Sprintf("%x", buffer), nil
}

func tokenHash(raw string) string {
	digest := sha256.Sum256([]byte(raw))
	return base64.RawURLEncoding.EncodeToString(digest[:])
}
