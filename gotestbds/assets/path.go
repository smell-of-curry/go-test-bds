package assets

import (
	"fmt"
	"path"
	"path/filepath"
	"strings"
)

// NormalizePath returns a pack-relative POSIX path, lower-cased. Empty,
// absolute, or traversal paths return an error.
//
// @param p Raw path from a URL or index key.
// @returns the normalized path.
// @throws when the path is empty, absolute, or contains ".." segments.
func NormalizePath(p string) (string, error) {
	p = strings.ReplaceAll(p, "\\", "/")
	p = strings.TrimSpace(p)
	if p == "" {
		return "", fmt.Errorf("assets: empty path")
	}
	if strings.HasPrefix(p, "/") || strings.Contains(p, ":") {
		return "", fmt.Errorf("assets: absolute path rejected: %q", p)
	}
	clean := path.Clean(p)
	if clean == "." || clean == ".." || strings.HasPrefix(clean, "../") {
		return "", fmt.Errorf("assets: path traversal rejected: %q", p)
	}
	for _, seg := range strings.Split(clean, "/") {
		if seg == ".." {
			return "", fmt.Errorf("assets: path traversal rejected: %q", p)
		}
	}
	return strings.ToLower(clean), nil
}

// SafeJoin joins root with a pack-relative path and ensures the result stays
// under root on the local filesystem.
//
// @param root Absolute filesystem root of a pack or cache entry.
// @param rel Pack-relative path (will be normalized).
// @returns the absolute filesystem path.
// @throws when the path is invalid or would escape root.
func SafeJoin(root, rel string) (string, error) {
	norm, err := NormalizePath(rel)
	if err != nil {
		return "", err
	}
	absRoot, err := filepath.Abs(root)
	if err != nil {
		return "", err
	}
	joined := filepath.Join(absRoot, filepath.FromSlash(norm))
	relToRoot, err := filepath.Rel(absRoot, joined)
	if err != nil {
		return "", fmt.Errorf("assets: path escapes root: %q", rel)
	}
	if relToRoot == ".." || strings.HasPrefix(relToRoot, ".."+string(filepath.Separator)) {
		return "", fmt.Errorf("assets: path escapes root: %q", rel)
	}
	return joined, nil
}
