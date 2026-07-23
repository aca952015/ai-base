package main

import (
	"crypto/sha256"
	"encoding/hex"
	"net/http"
	"sort"
	"strings"
	"sync"
	"time"
)

const (
	authenticatedClientRetention  = 24 * time.Hour
	authenticatedClientActiveTime = 15 * time.Minute
	authenticatedClientLimit      = 500
)

type authenticatedClientRegistry struct {
	mu      sync.Mutex
	clients map[string]authenticatedClientRecord
	now     func() time.Time
}

type authenticatedClientRecord struct {
	ID                 string
	ClientID           string
	SubjectFingerprint string
	DisplayName        string
	Email              string
	Issuer             string
	FirstSeenAt        time.Time
	LastSeenAt         time.Time
	RequestCount       uint64
	LastMethod         string
	LastPath           string
}

type authenticatedClientSnapshot struct {
	ID                 string    `json:"id"`
	ClientID           string    `json:"clientId"`
	SubjectFingerprint string    `json:"subjectFingerprint"`
	DisplayName        string    `json:"displayName,omitempty"`
	Email              string    `json:"email,omitempty"`
	Issuer             string    `json:"issuer"`
	FirstSeenAt        time.Time `json:"firstSeenAt"`
	LastSeenAt         time.Time `json:"lastSeenAt"`
	RequestCount       uint64    `json:"requestCount"`
	LastMethod         string    `json:"lastMethod"`
	LastPath           string    `json:"lastPath"`
	Active             bool      `json:"active"`
}

type authenticatedClientsSnapshot struct {
	GeneratedAt         time.Time                     `json:"generatedAt"`
	RetentionSeconds    int64                         `json:"retentionSeconds"`
	ActiveWindowSeconds int64                         `json:"activeWindowSeconds"`
	Clients             []authenticatedClientSnapshot `json:"clients"`
}

func newAuthenticatedClientRegistry() *authenticatedClientRegistry {
	return &authenticatedClientRegistry{
		clients: make(map[string]authenticatedClientRecord),
		now:     time.Now,
	}
}

func (r *authenticatedClientRegistry) record(caller identity, request *http.Request) {
	now := r.now().UTC()
	id := identityFingerprint(caller.issuer, caller.subject, caller.clientID)

	r.mu.Lock()
	defer r.mu.Unlock()

	r.removeExpiredLocked(now)
	record, exists := r.clients[id]
	if !exists {
		record = authenticatedClientRecord{
			ID:                 id,
			ClientID:           fallbackValue(caller.clientID, "unknown"),
			SubjectFingerprint: "usr_" + identityFingerprint(caller.issuer, caller.subject, "")[:12],
			Issuer:             caller.issuer,
			FirstSeenAt:        now,
		}
	}
	record.DisplayName = strings.TrimSpace(caller.displayName)
	record.Email = strings.TrimSpace(caller.email)
	record.LastSeenAt = now
	record.RequestCount++
	record.LastMethod = request.Method
	record.LastPath = request.URL.Path
	r.clients[id] = record

	r.enforceLimitLocked()
}

func (r *authenticatedClientRegistry) snapshot() authenticatedClientsSnapshot {
	now := r.now().UTC()

	r.mu.Lock()
	defer r.mu.Unlock()

	r.removeExpiredLocked(now)
	clients := make([]authenticatedClientSnapshot, 0, len(r.clients))
	for _, record := range r.clients {
		clients = append(clients, authenticatedClientSnapshot{
			ID:                 record.ID,
			ClientID:           record.ClientID,
			SubjectFingerprint: record.SubjectFingerprint,
			DisplayName:        record.DisplayName,
			Email:              record.Email,
			Issuer:             record.Issuer,
			FirstSeenAt:        record.FirstSeenAt,
			LastSeenAt:         record.LastSeenAt,
			RequestCount:       record.RequestCount,
			LastMethod:         record.LastMethod,
			LastPath:           record.LastPath,
			Active:             now.Sub(record.LastSeenAt) <= authenticatedClientActiveTime,
		})
	}
	sort.Slice(clients, func(i, j int) bool {
		return clients[i].LastSeenAt.After(clients[j].LastSeenAt)
	})

	return authenticatedClientsSnapshot{
		GeneratedAt:         now,
		RetentionSeconds:    int64(authenticatedClientRetention.Seconds()),
		ActiveWindowSeconds: int64(authenticatedClientActiveTime.Seconds()),
		Clients:             clients,
	}
}

func (r *authenticatedClientRegistry) removeExpiredLocked(now time.Time) {
	cutoff := now.Add(-authenticatedClientRetention)
	for id, record := range r.clients {
		if record.LastSeenAt.Before(cutoff) {
			delete(r.clients, id)
		}
	}
}

func (r *authenticatedClientRegistry) enforceLimitLocked() {
	for len(r.clients) > authenticatedClientLimit {
		var oldestID string
		var oldestTime time.Time
		for id, record := range r.clients {
			if oldestID == "" || record.LastSeenAt.Before(oldestTime) {
				oldestID = id
				oldestTime = record.LastSeenAt
			}
		}
		delete(r.clients, oldestID)
	}
}

func identityFingerprint(parts ...string) string {
	sum := sha256.Sum256([]byte(strings.Join(parts, "\x00")))
	return hex.EncodeToString(sum[:])
}

func fallbackValue(value, fallback string) string {
	value = strings.TrimSpace(value)
	if value == "" {
		return fallback
	}
	return value
}
