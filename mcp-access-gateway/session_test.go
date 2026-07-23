package main

import (
	"testing"
	"time"
)

func TestSessionIsBoundToIdentity(t *testing.T) {
	signer := newSessionSigner([]byte("test-session-signing-key-at-least-32-bytes"), time.Hour)
	now := time.Unix(1_800_000_000, 0)
	signer.now = func() time.Time { return now }

	alice := identity{issuer: "https://id.example", subject: "alice", clientID: "workbuddy"}
	bob := identity{issuer: "https://id.example", subject: "bob", clientID: "workbuddy"}

	sealed, err := signer.seal("envoy-session", alice)
	if err != nil {
		t.Fatal(err)
	}
	if got, err := signer.open(sealed, alice); err != nil || got != "envoy-session" {
		t.Fatalf("expected Alice to open her session, got %q, %v", got, err)
	}
	if _, err := signer.open(sealed, bob); err == nil {
		t.Fatal("expected another identity to be rejected")
	}
}

func TestSessionExpires(t *testing.T) {
	signer := newSessionSigner([]byte("test-session-signing-key-at-least-32-bytes"), time.Hour)
	now := time.Unix(1_800_000_000, 0)
	signer.now = func() time.Time { return now }
	caller := identity{issuer: "https://id.example", subject: "alice"}

	sealed, err := signer.seal("envoy-session", caller)
	if err != nil {
		t.Fatal(err)
	}
	signer.now = func() time.Time { return now.Add(2 * time.Hour) }
	if _, err := signer.open(sealed, caller); err == nil {
		t.Fatal("expected expired session to be rejected")
	}
}
