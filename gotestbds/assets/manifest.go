package assets

import (
	"encoding/json"
	"fmt"
	"os"
	"strconv"
	"strings"

	"github.com/google/uuid"
)

// Manifest is the subset of pack_manifest / manifest.json needed for stack
// resolution and subpack selection. gophertunnel's resource.Manifest omits
// subpacks, so this package parses them itself.
type Manifest struct {
	FormatVersion any       `json:"format_version"`
	Header        Header    `json:"header"`
	Modules       []Module  `json:"modules"`
	Subpacks      []Subpack `json:"subpacks,omitempty"`
}

// Header identifies a pack.
type Header struct {
	Name        string    `json:"name"`
	Description string    `json:"description"`
	UUID        uuid.UUID `json:"uuid"`
	Version     Version   `json:"version"`
}

// Module is one content module inside a pack.
type Module struct {
	Type    string  `json:"type"`
	UUID    string  `json:"uuid"`
	Version Version `json:"version"`
}

// Subpack describes a memory-tiered override directory under subpacks/.
//
// Selection follows Microsoft's Building Sub-Packs docs: pick the highest
// memory_performance_tier (falling back to memory_tier) that does not exceed
// the device tier; on a tie, the last matching entry in the array wins.
// See https://learn.microsoft.com/en-us/minecraft/creator/documents/buildingsubpacks
type Subpack struct {
	FolderName            string `json:"folder_name"`
	Name                  string `json:"name"`
	MemoryTier            int    `json:"memory_tier"`
	MemoryPerformanceTier int    `json:"memory_performance_tier"`
}

// Version accepts [1,0,0] or "1.0.0".
type Version [3]int

func (v Version) String() string {
	return strconv.Itoa(v[0]) + "." + strconv.Itoa(v[1]) + "." + strconv.Itoa(v[2])
}

func (v *Version) UnmarshalJSON(b []byte) error {
	var arr [3]int
	if err := json.Unmarshal(b, &arr); err == nil {
		*v = arr
		return nil
	}
	var s string
	if err := json.Unmarshal(b, &s); err != nil {
		return fmt.Errorf("invalid version: %s", string(b))
	}
	parts := strings.Split(strings.TrimSpace(s), ".")
	if len(parts) != 3 {
		return fmt.Errorf("invalid version %q (need x.y.z)", s)
	}
	for i := range 3 {
		n, err := strconv.Atoi(parts[i])
		if err != nil {
			return fmt.Errorf("invalid version component %q in %q", parts[i], s)
		}
		v[i] = n
	}
	return nil
}

// ReadManifest parses manifest.json at path.
//
// @param path Filesystem path to manifest.json.
// @returns the parsed Manifest.
// @throws when the file cannot be read or parsed.
func ReadManifest(path string) (Manifest, error) {
	b, err := os.ReadFile(path)
	if err != nil {
		return Manifest{}, err
	}
	var m Manifest
	if err := json.Unmarshal(b, &m); err != nil {
		return Manifest{}, fmt.Errorf("parse manifest %s: %w", path, err)
	}
	if m.Header.UUID == uuid.Nil {
		return Manifest{}, fmt.Errorf("manifest %s: missing header.uuid", path)
	}
	return m, nil
}

// HasResources reports whether any module is type "resources".
func (m Manifest) HasResources() bool {
	for _, mod := range m.Modules {
		if mod.Type == "resources" {
			return true
		}
	}
	return false
}

// SelectSubpack picks the subpack folder for a device memory performance tier.
//
// Rule (Microsoft Learn — Building Sub-Packs):
//  1. Prefer memory_performance_tier when set (>0); otherwise use memory_tier.
//  2. Choose the highest tier value that does not exceed deviceTier.
//  3. On a tie, the last matching subpack in the manifest array wins.
//  4. An explicit forced name (from ResourcePackStack.SubPackName) wins over auto-select.
//
// @param deviceTier Device memory_performance_tier (1–5), or a legacy memory_tier when packs only declare that.
// @param forced Optional SubPackName from the wire stack; empty means auto-select.
// @returns the folder_name to apply under subpacks/, or "" for root-only.
func (m Manifest) SelectSubpack(deviceTier int, forced string) string {
	if forced != "" {
		for _, sp := range m.Subpacks {
			if sp.FolderName == forced {
				return sp.FolderName
			}
		}
		// Unknown forced name: still honour it so a server-selected subpack
		// that we have on disk is used even if the manifest parse drifted.
		return forced
	}
	if len(m.Subpacks) == 0 || deviceTier < 0 {
		return ""
	}
	bestTier := -1
	bestFolder := ""
	for _, sp := range m.Subpacks {
		tier := sp.MemoryPerformanceTier
		if tier <= 0 {
			tier = sp.MemoryTier
		}
		if tier > deviceTier {
			continue
		}
		if tier > bestTier || tier == bestTier {
			bestTier = tier
			bestFolder = sp.FolderName
		}
	}
	return bestFolder
}
