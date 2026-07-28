package assets

import (
	"fmt"
	"io/fs"
	"os"
	"path/filepath"
	"strings"
)

// PackIDVanilla is the stable id of the pinned bedrock-samples baseline.
const PackIDVanilla = "vanilla"

// Pack is an extracted resource pack on disk, with an optional active subpack.
type Pack struct {
	ID       string
	UUID     string
	Version  string
	Name     string
	Priority int // 0 = lowest (vanilla); higher applied later and wins
	Root     string
	Subpack  string // folder_name under subpacks/, empty for root-only
	manifest Manifest
	files    map[string]string // normalized path → absolute filesystem path
}

// OpenPack loads an extracted pack directory and builds its file map with the
// selected subpack applied (subpack files override root).
//
// @param id Stable pack id ("vanilla" or uuid).
// @param root Absolute path to the pack root (directory containing manifest.json).
// @param priority Stack priority (0 = lowest).
// @param deviceTier Memory performance tier for subpack auto-select.
// @param forcedSubpack SubPackName from the wire, or empty.
// @returns the loaded Pack.
// @throws when the manifest is missing or the pack has no resources module.
func OpenPack(id, root string, priority, deviceTier int, forcedSubpack string) (*Pack, error) {
	manifestPath := filepath.Join(root, "manifest.json")
	m, err := ReadManifest(manifestPath)
	if err != nil {
		return nil, err
	}
	if !m.HasResources() {
		return nil, fmt.Errorf("assets: pack %s at %s has no resources module (behaviour packs are not an asset source)", id, root)
	}
	sub := m.SelectSubpack(deviceTier, forcedSubpack)
	p := &Pack{
		ID:       id,
		UUID:     m.Header.UUID.String(),
		Version:  m.Header.Version.String(),
		Name:     m.Header.Name,
		Priority: priority,
		Root:     root,
		Subpack:  sub,
		manifest: m,
		files:    make(map[string]string),
	}
	if err := p.indexRoot(); err != nil {
		return nil, err
	}
	if sub != "" {
		if err := p.indexSubpack(sub); err != nil && !os.IsNotExist(err) {
			return nil, err
		}
	}
	return p, nil
}

func (p *Pack) indexRoot() error {
	return filepath.WalkDir(p.Root, func(fpath string, d fs.DirEntry, err error) error {
		if err != nil {
			return err
		}
		rel, err := filepath.Rel(p.Root, fpath)
		if err != nil {
			return err
		}
		rel = filepath.ToSlash(rel)
		if rel == "." {
			return nil
		}
		// Skip the subpacks tree at root indexing; subpack files are layered on top.
		if rel == "subpacks" || strings.HasPrefix(rel, "subpacks/") {
			if d.IsDir() && rel == "subpacks" {
				return filepath.SkipDir
			}
			return nil
		}
		if d.IsDir() {
			return nil
		}
		norm, err := NormalizePath(rel)
		if err != nil {
			return nil // skip odd names rather than failing the whole pack
		}
		p.files[norm] = fpath
		return nil
	})
}

func (p *Pack) indexSubpack(folder string) error {
	base := filepath.Join(p.Root, "subpacks", folder)
	info, err := os.Stat(base)
	if err != nil {
		return err
	}
	if !info.IsDir() {
		return fmt.Errorf("assets: subpack %q is not a directory", folder)
	}
	return filepath.WalkDir(base, func(fpath string, d fs.DirEntry, err error) error {
		if err != nil {
			return err
		}
		if d.IsDir() {
			return nil
		}
		rel, err := filepath.Rel(base, fpath)
		if err != nil {
			return err
		}
		norm, err := NormalizePath(filepath.ToSlash(rel))
		if err != nil {
			return nil
		}
		p.files[norm] = fpath
		return nil
	})
}

// FileCount returns the number of files visible after subpack merge.
func (p *Pack) FileCount() int { return len(p.files) }

// Has reports whether the pack contains path after subpack merge.
func (p *Pack) Has(packPath string) bool {
	norm, err := NormalizePath(packPath)
	if err != nil {
		return false
	}
	_, ok := p.files[norm]
	return ok
}

// ReadFile returns the bytes for a pack-relative path.
//
// @param packPath Pack-relative path.
// @returns file bytes.
// @throws when the path is invalid or absent.
func (p *Pack) ReadFile(packPath string) ([]byte, error) {
	norm, err := NormalizePath(packPath)
	if err != nil {
		return nil, err
	}
	abs, ok := p.files[norm]
	if !ok {
		return nil, fmt.Errorf("assets: %s: file %q not found", p.ID, packPath)
	}
	return os.ReadFile(abs)
}

// Files returns a copy of the normalized path set.
func (p *Pack) Files() map[string]string {
	out := make(map[string]string, len(p.files))
	for k, v := range p.files {
		out[k] = v
	}
	return out
}

// Info is the JSON shape of GET /packs entries.
type Info struct {
	ID        string `json:"id"`
	UUID      string `json:"uuid"`
	Version   string `json:"version"`
	Name      string `json:"name"`
	Priority  int    `json:"priority"`
	FileCount int    `json:"fileCount"`
}

// Info returns the public pack descriptor.
func (p *Pack) Info() Info {
	return Info{
		ID:        p.ID,
		UUID:      p.UUID,
		Version:   p.Version,
		Name:      p.Name,
		Priority:  p.Priority,
		FileCount: p.FileCount(),
	}
}
