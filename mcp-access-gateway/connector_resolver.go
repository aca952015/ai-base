package main

import (
	"bytes"
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"net/http"
	"net/url"
	"strings"
	"time"
)

var (
	errConnectorBindingNotFound     = errors.New("connector binding not found")
	errConnectorResolverUnavailable = errors.New("connector binding resolver unavailable")
	errInvalidConnectorBinding      = errors.New("invalid connector binding")
)

type connectorBinding struct {
	ID             string         `json:"id,omitempty"`
	Service        string         `json:"service"`
	ConnectionName string         `json:"connectionName"`
	AuthType       string         `json:"authType,omitempty"`
	DisplayName    string         `json:"displayName,omitempty"`
	Profile        map[string]any `json:"profile,omitempty"`
	Public         bool           `json:"public,omitempty"`
}

type connectorBindingResolver interface {
	resolve(context.Context, identity, string) (connectorBinding, error)
	list(context.Context, identity) ([]connectorBinding, error)
}

type httpConnectorBindingResolver struct {
	endpoint *url.URL
	token    string
	client   *http.Client
}

func newHTTPConnectorBindingResolver(cfg config) *httpConnectorBindingResolver {
	return &httpConnectorBindingResolver{
		endpoint: cfg.connectorResolverURL,
		token:    cfg.connectorResolverToken,
		client: &http.Client{
			Timeout: 10 * time.Second,
		},
	}
}

func (r *httpConnectorBindingResolver) resolve(
	ctx context.Context,
	caller identity,
	service string,
) (connectorBinding, error) {
	payload, err := r.request(ctx, caller, service)
	if err != nil {
		return connectorBinding{}, err
	}

	binding, ok := decodeResolvedBinding(payload)
	if !ok {
		return connectorBinding{}, errInvalidConnectorBinding
	}
	binding.Service = strings.TrimSpace(binding.Service)
	binding.ConnectionName = strings.TrimSpace(binding.ConnectionName)
	if binding.Service == "" {
		binding.Service = service
	}
	if binding.Service != service {
		return connectorBinding{}, errInvalidConnectorBinding
	}
	if binding.Public {
		if binding.ConnectionName != "" && !strings.EqualFold(binding.ConnectionName, "default") {
			return connectorBinding{}, errInvalidConnectorBinding
		}
		binding.ConnectionName = "default"
		return binding, nil
	}
	if !validNamedConnection(binding.ConnectionName) {
		return connectorBinding{}, errInvalidConnectorBinding
	}
	return binding, nil
}

func (r *httpConnectorBindingResolver) list(
	ctx context.Context,
	caller identity,
) ([]connectorBinding, error) {
	payload, err := r.request(ctx, caller, "")
	if err != nil {
		return nil, err
	}

	bindings, ok := decodeBindingList(payload)
	if !ok {
		return nil, errInvalidConnectorBinding
	}

	result := make([]connectorBinding, 0, len(bindings))
	for _, binding := range bindings {
		binding.Service = strings.TrimSpace(binding.Service)
		binding.ConnectionName = strings.TrimSpace(binding.ConnectionName)
		if binding.Service == "" {
			return nil, errInvalidConnectorBinding
		}
		if binding.Public {
			if binding.ConnectionName != "" && !strings.EqualFold(binding.ConnectionName, "default") {
				return nil, errInvalidConnectorBinding
			}
			binding.ConnectionName = "default"
		} else if !validNamedConnection(binding.ConnectionName) {
			return nil, errInvalidConnectorBinding
		}
		result = append(result, binding)
	}
	return result, nil
}

func validNamedConnection(value string) bool {
	if value == "" || len(value) > 64 || strings.EqualFold(value, "default") {
		return false
	}
	for index, character := range value {
		if (character >= 'a' && character <= 'z') ||
			(character >= 'A' && character <= 'Z') ||
			(character >= '0' && character <= '9') ||
			(index > 0 && (character == '_' || character == '-')) {
			continue
		}
		return false
	}
	return true
}

func (r *httpConnectorBindingResolver) request(
	ctx context.Context,
	caller identity,
	service string,
) (json.RawMessage, error) {
	if r.endpoint == nil || r.token == "" {
		return nil, errConnectorResolverUnavailable
	}

	body, err := json.Marshal(map[string]string{
		"issuer":  caller.issuer,
		"subject": caller.subject,
		"email":   strings.ToLower(strings.TrimSpace(caller.email)),
		"service": service,
	})
	if err != nil {
		return nil, errConnectorResolverUnavailable
	}

	request, err := http.NewRequestWithContext(ctx, http.MethodPost, r.endpoint.String(), bytes.NewReader(body))
	if err != nil {
		return nil, errConnectorResolverUnavailable
	}
	request.Header.Set("Authorization", "Bearer "+r.token)
	request.Header.Set("Content-Type", "application/json")
	request.Header.Set("Accept", "application/json")

	response, err := r.client.Do(request)
	if err != nil {
		return nil, fmt.Errorf("%w: %v", errConnectorResolverUnavailable, err)
	}
	defer response.Body.Close()

	if response.StatusCode == http.StatusNotFound {
		return nil, errConnectorBindingNotFound
	}
	if response.StatusCode < http.StatusOK || response.StatusCode >= http.StatusMultipleChoices {
		_, _ = io.Copy(io.Discard, io.LimitReader(response.Body, 8<<10))
		return nil, fmt.Errorf("%w: status %d", errConnectorResolverUnavailable, response.StatusCode)
	}

	payload, err := io.ReadAll(io.LimitReader(response.Body, 1<<20))
	if err != nil || len(payload) == 0 || !json.Valid(payload) {
		return nil, errInvalidConnectorBinding
	}
	return payload, nil
}

func decodeResolvedBinding(payload json.RawMessage) (connectorBinding, bool) {
	var direct connectorBinding
	if err := json.Unmarshal(payload, &direct); err == nil && direct.ConnectionName != "" {
		return direct, true
	}

	var envelope struct {
		Binding json.RawMessage `json:"binding"`
		Data    json.RawMessage `json:"data"`
	}
	if err := json.Unmarshal(payload, &envelope); err != nil {
		return connectorBinding{}, false
	}
	for _, candidate := range []json.RawMessage{envelope.Binding, envelope.Data} {
		if len(candidate) == 0 {
			continue
		}
		if err := json.Unmarshal(candidate, &direct); err == nil && direct.ConnectionName != "" {
			return direct, true
		}
	}
	return connectorBinding{}, false
}

func decodeBindingList(payload json.RawMessage) ([]connectorBinding, bool) {
	var direct []connectorBinding
	if err := json.Unmarshal(payload, &direct); err == nil {
		return direct, true
	}

	var envelope struct {
		Connections json.RawMessage `json:"connections"`
		Bindings    json.RawMessage `json:"bindings"`
		Data        json.RawMessage `json:"data"`
	}
	if err := json.Unmarshal(payload, &envelope); err != nil {
		return nil, false
	}
	for _, candidate := range []json.RawMessage{envelope.Connections, envelope.Bindings, envelope.Data} {
		if len(candidate) == 0 {
			continue
		}
		if err := json.Unmarshal(candidate, &direct); err == nil {
			return direct, true
		}
	}
	return nil, false
}
