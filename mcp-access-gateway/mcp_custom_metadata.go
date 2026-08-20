package main

import (
	"encoding/json"
	"os"
	"strings"
)

type customMCPMetadata struct {
	displayName string
}

type storedCustomMCPServers struct {
	Servers []struct {
		Name      string `json:"name"`
		Namespace string `json:"namespace"`
		Enabled   bool   `json:"enabled"`
	} `json:"servers"`
}

func loadCustomMCPMetadata(filePath string) map[string]customMCPMetadata {
	metadata := make(map[string]customMCPMetadata)
	if strings.TrimSpace(filePath) == "" {
		return metadata
	}
	raw, err := os.ReadFile(filePath)
	if err != nil {
		return metadata
	}
	var stored storedCustomMCPServers
	if json.Unmarshal(raw, &stored) != nil {
		return metadata
	}
	for _, server := range stored.Servers {
		name := compactCustomMCPText(server.Name, 100)
		if server.Enabled && validCustomMCPNamespace(server.Namespace) && name != "" {
			metadata[server.Namespace] = customMCPMetadata{displayName: name}
		}
	}
	return metadata
}
