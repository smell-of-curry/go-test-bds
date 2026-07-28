package assets

import (
	"mime"
	"path"
	"strings"
)

// ContentType returns a sensible Content-Type for a pack-relative path.
//
// @param packPath Normalized pack-relative path.
// @returns a MIME type string.
func ContentType(packPath string) string {
	ext := strings.ToLower(path.Ext(packPath))
	if ext == "" {
		return "application/octet-stream"
	}
	if ct := mime.TypeByExtension(ext); ct != "" {
		return ct
	}
	switch ext {
	case ".json", ".mcmeta":
		return "application/json"
	case ".lang":
		return "text/plain; charset=utf-8"
	case ".tga":
		return "image/tga"
	case ".fsb":
		return "application/octet-stream"
	default:
		return "application/octet-stream"
	}
}
