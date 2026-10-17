package viewer

import (
	"net/http"
	"path/filepath"
	"strings"
)

// handleFont serves one font file from Options.FontDir.
//
// Only a single path segment is accepted. `..`, slashes and empty names are
// rejected. An unset directory is a 404 — the TTF is Mojang content and is
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
	root, err := filepath.Abs(h.opts.FontDir)
	if err != nil {
		http.Error(w, err.Error(), http.StatusInternalServerError)
		return
	}
	full := filepath.Join(root, name)
	rel, err := filepath.Rel(root, full)
	if err != nil || rel != name || strings.HasPrefix(rel, "..") {
		http.NotFound(w, r)
		return
	}
	w.Header().Set("Content-Type", "font/ttf")
	http.ServeFile(w, r, full)
}

// safeFontName reports whether name is a single file name.
//
// @param name - URL path segment.
// @returns false when the name could escape FontDir.
func safeFontName(name string) bool {
	if name == "" || name != filepath.Base(name) {
		return false
	}
	if strings.Contains(name, "..") || strings.ContainsAny(name, `/\`) {
		return false
	}
	return true
}
