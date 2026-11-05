package viewer

import (
	"net/http"
	"os"
	"path/filepath"
	"strings"
)

// handleFont serves one font file from Options.FontDir.
//
// Only a single path segment is accepted. `..`, slashes and empty names are
// rejected. An unset directory is a 404 — fonts/atlases are Mojang content and are
// configured on the host, not shipped in the repo.
func (h *Hub) handleFont(w http.ResponseWriter, r *http.Request) {
	w.Header().Set("Access-Control-Allow-Origin", "*")
	name := r.PathValue("name")
	if !safeFontName(name) {
		http.Error(w, "invalid font name", http.StatusBadRequest)
		return
	}
	if h.opts.FontDir == "" {
		http.NotFound(w, r)
		return
	}
	root, err := os.OpenRoot(h.opts.FontDir)
	if err != nil {
		http.NotFound(w, r)
		return
	}
	defer root.Close()
	font, err := root.Open(name)
	if err != nil {
		http.NotFound(w, r)
		return
	}
	defer font.Close()
	info, err := font.Stat()
	if err != nil || !info.Mode().IsRegular() {
		http.NotFound(w, r)
		return
	}
	if strings.EqualFold(filepath.Ext(name), ".png") {
		w.Header().Set("Content-Type", "image/png")
	} else if strings.EqualFold(name, "default8.json") {
		w.Header().Set("Content-Type", "application/json")
	} else {
		w.Header().Set("Content-Type", "font/ttf")
	}
	http.ServeContent(w, r, name, info.ModTime(), font)
}

// safeFontName reports whether name is a single file name.
//
// @param name - URL path segment.
// @returns false when the name could escape FontDir.
func safeFontName(name string) bool {
	ext := strings.ToLower(filepath.Ext(name))
	if name == "" || name != filepath.Base(name) || (ext != ".ttf" && ext != ".png" && !strings.EqualFold(name, "default8.json")) {
		return false
	}
	if strings.Contains(name, "..") || strings.ContainsAny(name, `/\`) {
		return false
	}
	return true
}
