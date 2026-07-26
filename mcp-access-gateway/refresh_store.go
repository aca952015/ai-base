package main

import (
	"encoding/base64"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"os"
	"path/filepath"
	"time"
)

const (
	refreshGrantStoreVersion = 1
	maxRefreshGrantStoreSize = 16 << 20
)

type refreshGrantStore struct {
	path string
}

type refreshGrantStorePayload struct {
	Version int                     `json:"version"`
	Grants  map[string]refreshGrant `json:"grants"`
}

func newRefreshGrantStore(path string) *refreshGrantStore {
	return &refreshGrantStore{path: path}
}

func (s *refreshGrantStore) load(now time.Time) (map[string]refreshGrant, error) {
	grants := make(map[string]refreshGrant)
	if s.path == "" {
		return grants, nil
	}

	file, err := os.Open(s.path)
	if errors.Is(err, os.ErrNotExist) {
		return grants, nil
	}
	if err != nil {
		return nil, fmt.Errorf("open OAuth refresh grant store: %w", err)
	}
	defer file.Close()

	contents, err := io.ReadAll(io.LimitReader(file, maxRefreshGrantStoreSize+1))
	if err != nil {
		return nil, fmt.Errorf("read OAuth refresh grant store: %w", err)
	}
	if len(contents) > maxRefreshGrantStoreSize {
		return nil, errors.New("OAuth refresh grant store exceeds the size limit")
	}

	var payload refreshGrantStorePayload
	if err := json.Unmarshal(contents, &payload); err != nil {
		return nil, fmt.Errorf("decode OAuth refresh grant store: %w", err)
	}
	if payload.Version != refreshGrantStoreVersion {
		return nil, fmt.Errorf("unsupported OAuth refresh grant store version: %d", payload.Version)
	}
	for tokenHash, grant := range payload.Grants {
		if !validRefreshTokenHash(tokenHash) ||
			grant.ClientID == "" ||
			grant.Resource == "" ||
			grant.Employee.Subject == "" ||
			grant.ExpiresAt.IsZero() {
			return nil, errors.New("OAuth refresh grant store contains an invalid grant")
		}
		if grant.ExpiresAt.After(now) {
			grants[tokenHash] = grant
		}
	}
	return grants, nil
}

func (s *refreshGrantStore) save(grants map[string]refreshGrant) error {
	if s.path == "" {
		return nil
	}

	contents, err := json.Marshal(refreshGrantStorePayload{
		Version: refreshGrantStoreVersion,
		Grants:  grants,
	})
	if err != nil {
		return fmt.Errorf("encode OAuth refresh grant store: %w", err)
	}
	if len(contents) > maxRefreshGrantStoreSize {
		return errors.New("OAuth refresh grant store exceeds the size limit")
	}

	directory := filepath.Dir(s.path)
	if err := os.MkdirAll(directory, 0o700); err != nil {
		return fmt.Errorf("create OAuth refresh grant directory: %w", err)
	}
	temp, err := os.CreateTemp(directory, ".oauth-refresh-grants-*")
	if err != nil {
		return fmt.Errorf("create OAuth refresh grant store: %w", err)
	}
	tempName := temp.Name()
	defer func() { _ = os.Remove(tempName) }()

	if err := temp.Chmod(0o600); err != nil {
		_ = temp.Close()
		return fmt.Errorf("secure OAuth refresh grant store: %w", err)
	}
	if _, err := temp.Write(contents); err != nil {
		_ = temp.Close()
		return fmt.Errorf("write OAuth refresh grant store: %w", err)
	}
	if err := temp.Sync(); err != nil {
		_ = temp.Close()
		return fmt.Errorf("sync OAuth refresh grant store: %w", err)
	}
	if err := temp.Close(); err != nil {
		return fmt.Errorf("close OAuth refresh grant store: %w", err)
	}
	if err := os.Rename(tempName, s.path); err != nil {
		return fmt.Errorf("replace OAuth refresh grant store: %w", err)
	}
	if directoryHandle, err := os.Open(directory); err == nil {
		_ = directoryHandle.Sync()
		_ = directoryHandle.Close()
	}
	return nil
}

func validRefreshTokenHash(value string) bool {
	decoded, err := base64.RawURLEncoding.DecodeString(value)
	return err == nil && len(decoded) == 32
}
