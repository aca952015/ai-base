package main

import (
	"crypto/hmac"
	"crypto/sha256"
	"encoding/base64"
	"encoding/json"
	"errors"
	"strconv"
	"strings"
	"time"
)

var errInvalidSession = errors.New("invalid MCP session")

type sessionSigner struct {
	key      []byte
	lifetime time.Duration
	now      func() time.Time
}

type signedSession struct {
	UpstreamSession string `json:"sid"`
	IdentityHash    string `json:"identity"`
	ExpiresAt       int64  `json:"exp"`
}

func newSessionSigner(key []byte, lifetime time.Duration) *sessionSigner {
	return &sessionSigner{
		key:      key,
		lifetime: lifetime,
		now:      time.Now,
	}
}

func (s *sessionSigner) seal(upstreamSession string, caller identity) (string, error) {
	payload, err := json.Marshal(signedSession{
		UpstreamSession: upstreamSession,
		IdentityHash:    identityHash(caller),
		ExpiresAt:       s.now().Add(s.lifetime).Unix(),
	})
	if err != nil {
		return "", err
	}
	encoded := base64.RawURLEncoding.EncodeToString(payload)
	return "v1." + encoded + "." + s.signature(encoded), nil
}

func (s *sessionSigner) open(value string, caller identity) (string, error) {
	parts := strings.Split(value, ".")
	if len(parts) != 3 || parts[0] != "v1" {
		return "", errInvalidSession
	}
	if !hmac.Equal([]byte(parts[2]), []byte(s.signature(parts[1]))) {
		return "", errInvalidSession
	}

	payload, err := base64.RawURLEncoding.DecodeString(parts[1])
	if err != nil {
		return "", errInvalidSession
	}
	var session signedSession
	if err := json.Unmarshal(payload, &session); err != nil {
		return "", errInvalidSession
	}
	if session.UpstreamSession == "" ||
		session.IdentityHash != identityHash(caller) ||
		session.ExpiresAt <= s.now().Unix() {
		return "", errInvalidSession
	}
	return session.UpstreamSession, nil
}

func (s *sessionSigner) signature(encodedPayload string) string {
	mac := hmac.New(sha256.New, s.key)
	_, _ = mac.Write([]byte(encodedPayload))
	return base64.RawURLEncoding.EncodeToString(mac.Sum(nil))
}

func identityHash(caller identity) string {
	hash := sha256.Sum256([]byte(
		strconv.Itoa(len(caller.issuer)) + ":" + caller.issuer +
			strconv.Itoa(len(caller.subject)) + ":" + caller.subject +
			strconv.Itoa(len(caller.clientID)) + ":" + caller.clientID,
	))
	return base64.RawURLEncoding.EncodeToString(hash[:])
}
