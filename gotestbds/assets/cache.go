package assets

import (
	"archive/zip"
	"fmt"
	"io"
	"io/fs"
	"os"
	"path/filepath"
	"strings"

	"github.com/google/uuid"
	"github.com/sandertv/gophertunnel/minecraft/resource"
)

// Cache stores extracted resource packs keyed by UUID and version under
// <Root>/packs/<uuid>/<version>/.
type Cache struct {
	Root string
}

// PackDir returns the extracted directory for uuid+version.
func (c *Cache) PackDir(id uuid.UUID, version string) string {
	return filepath.Join(c.Root, "packs", strings.ToLower(id.String()), sanitizeVersion(version))
}

// Has reports whether an extracted pack exists at the cache key.
func (c *Cache) Has(id uuid.UUID, version string) bool {
	_, err := os.Stat(filepath.Join(c.PackDir(id, version), "manifest.json"))
	return err == nil
}

// PutPack writes a gophertunnel resource.Pack into the cache and extracts it.
// Idempotent when the target already exists.
//
// @param pack Downloaded pack from Conn.ResourcePacks().
// @returns the extracted directory path.
// @throws when the archive cannot be written or extracted.
func (c *Cache) PutPack(pack *resource.Pack) (string, error) {
	if pack == nil {
		return "", fmt.Errorf("assets: nil pack")
	}
	if !pack.HasTextures() {
		return "", fmt.Errorf("assets: refusing behaviour-only pack %s", pack.UUID())
	}
	dest := c.PackDir(pack.UUID(), pack.Version())
	if _, err := os.Stat(filepath.Join(dest, "manifest.json")); err == nil {
		return dest, nil
	}
	if err := os.MkdirAll(filepath.Dir(dest), 0o755); err != nil {
		return "", err
	}
	tmpZip := dest + ".zip.tmp"
	f, err := os.Create(tmpZip)
	if err != nil {
		return "", err
	}
	buf := make([]byte, pack.Len())
	if _, err := pack.ReadAt(buf, 0); err != nil && err != io.EOF {
		_ = f.Close()
		_ = os.Remove(tmpZip)
		return "", fmt.Errorf("read pack bytes: %w", err)
	}
	if _, err := f.Write(buf); err != nil {
		_ = f.Close()
		_ = os.Remove(tmpZip)
		return "", err
	}
	if err := f.Close(); err != nil {
		_ = os.Remove(tmpZip)
		return "", err
	}
	finalZip := dest + ".zip"
	_ = os.Remove(finalZip)
	if err := os.Rename(tmpZip, finalZip); err != nil {
		_ = os.Remove(tmpZip)
		return "", err
	}
	tmpDir := dest + ".extract"
	_ = os.RemoveAll(tmpDir)
	if err := unzipTo(finalZip, tmpDir); err != nil {
		_ = os.RemoveAll(tmpDir)
		return "", err
	}
	// Zip may nest the pack in a single top-level folder; normalize so
	// manifest.json sits at dest/manifest.json.
	root, err := findPackRoot(tmpDir)
	if err != nil {
		_ = os.RemoveAll(tmpDir)
		return "", err
	}
	_ = os.RemoveAll(dest)
	if err := os.Rename(root, dest); err != nil {
		// Cross-device rename fallback.
		if err := copyDir(root, dest); err != nil {
			_ = os.RemoveAll(tmpDir)
			_ = os.RemoveAll(dest)
			return "", err
		}
		_ = os.RemoveAll(tmpDir)
	} else {
		_ = os.RemoveAll(tmpDir)
	}
	return dest, nil
}

// PutDirectory copies an already-extracted pack directory into the cache.
func (c *Cache) PutDirectory(id uuid.UUID, version, src string) (string, error) {
	dest := c.PackDir(id, version)
	if _, err := os.Stat(filepath.Join(dest, "manifest.json")); err == nil {
		return dest, nil
	}
	if err := copyDir(src, dest); err != nil {
		_ = os.RemoveAll(dest)
		return "", err
	}
	return dest, nil
}

func sanitizeVersion(v string) string {
	v = strings.TrimSpace(v)
	v = strings.ReplaceAll(v, "/", "_")
	v = strings.ReplaceAll(v, "\\", "_")
	if v == "" {
		return "0.0.0"
	}
	return v
}

func unzipTo(zipPath, dest string) error {
	r, err := zip.OpenReader(zipPath)
	if err != nil {
		return err
	}
	defer r.Close()
	if err := os.MkdirAll(dest, 0o755); err != nil {
		return err
	}
	for _, f := range r.File {
		name := filepath.ToSlash(f.Name)
		if name == "" || strings.HasPrefix(name, "/") || strings.Contains(name, "..") {
			return fmt.Errorf("assets: refused zip entry %q", f.Name)
		}
		target := filepath.Join(dest, filepath.FromSlash(name))
		rel, err := filepath.Rel(dest, target)
		if err != nil || rel == ".." || strings.HasPrefix(rel, ".."+string(filepath.Separator)) {
			return fmt.Errorf("assets: zip entry escapes dest: %q", f.Name)
		}
		if f.FileInfo().IsDir() {
			if err := os.MkdirAll(target, 0o755); err != nil {
				return err
			}
			continue
		}
		if err := os.MkdirAll(filepath.Dir(target), 0o755); err != nil {
			return err
		}
		rc, err := f.Open()
		if err != nil {
			return err
		}
		out, err := os.OpenFile(target, os.O_CREATE|os.O_WRONLY|os.O_TRUNC, 0o644)
		if err != nil {
			_ = rc.Close()
			return err
		}
		_, copyErr := io.Copy(out, rc)
		_ = out.Close()
		_ = rc.Close()
		if copyErr != nil {
			return copyErr
		}
	}
	return nil
}

func findPackRoot(dir string) (string, error) {
	if _, err := os.Stat(filepath.Join(dir, "manifest.json")); err == nil {
		return dir, nil
	}
	entries, err := os.ReadDir(dir)
	if err != nil {
		return "", err
	}
	for _, e := range entries {
		if !e.IsDir() {
			continue
		}
		candidate := filepath.Join(dir, e.Name())
		if _, err := os.Stat(filepath.Join(candidate, "manifest.json")); err == nil {
			return candidate, nil
		}
	}
	return "", fmt.Errorf("assets: no manifest.json under %s", dir)
}

func copyDir(src, dest string) error {
	return filepath.WalkDir(src, func(fpath string, d fs.DirEntry, err error) error {
		if err != nil {
			return err
		}
		rel, err := filepath.Rel(src, fpath)
		if err != nil {
			return err
		}
		target := filepath.Join(dest, rel)
		if d.IsDir() {
			return os.MkdirAll(target, 0o755)
		}
		if err := os.MkdirAll(filepath.Dir(target), 0o755); err != nil {
			return err
		}
		in, err := os.ReadFile(fpath)
		if err != nil {
			return err
		}
		return os.WriteFile(target, in, 0o644)
	})
}
