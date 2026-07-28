package wire

import (
	"encoding/json"
	"fmt"
	"os"
)

// BlocksJSONEntry is the subset of a resource-pack blocks.json row the
// precedence check cares about — sound and texture atlas names, never geometry.
type BlocksJSONEntry struct {
	Textures any    `json:"textures"`
	Sound    string `json:"sound"`
}

// TextureName returns a single texture short-name when the entry has one.
//
// @returns the texture name and true when a single string (or "all"/"side") is present.
func (e BlocksJSONEntry) TextureName() (string, bool) {
	switch t := e.Textures.(type) {
	case string:
		return t, t != ""
	case map[string]any:
		for _, key := range []string{"all", "side", "up"} {
			if s, ok := t[key].(string); ok && s != "" {
				return s, true
			}
		}
	case map[string]string:
		for _, key := range []string{"all", "side", "up"} {
			if s := t[key]; s != "" {
				return s, true
			}
		}
	}
	return "", false
}

// LoadBlocksJSON reads a resource-pack blocks.json into a name→entry map.
// The format_version key is skipped.
//
// @param path Filesystem path to blocks.json.
// @returns the map of block identifier to entry.
// @throws if the file cannot be read or parsed.
func LoadBlocksJSON(path string) (map[string]BlocksJSONEntry, error) {
	raw, err := os.ReadFile(path)
	if err != nil {
		return nil, err
	}
	var root map[string]json.RawMessage
	if err := json.Unmarshal(raw, &root); err != nil {
		return nil, fmt.Errorf("blocks.json: %w", err)
	}
	out := make(map[string]BlocksJSONEntry, len(root))
	for name, blob := range root {
		if name == "format_version" {
			continue
		}
		var e BlocksJSONEntry
		if err := json.Unmarshal(blob, &e); err != nil {
			return nil, fmt.Errorf("blocks.json %s: %w", name, err)
		}
		out[name] = e
	}
	return out, nil
}
