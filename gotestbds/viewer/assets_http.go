package viewer

import (
	"net/http"
	"strings"

	"github.com/smell-of-curry/go-test-bds/gotestbds/assets"
)

func (h *Hub) handlePacks(w http.ResponseWriter, _ *http.Request) {
	st := h.assetsStack()
	if st == nil {
		http.Error(w, "assets not configured", http.StatusServiceUnavailable)
		return
	}
	writeJSON(w, st.Packs())
}

func (h *Hub) handlePacksIndex(w http.ResponseWriter, _ *http.Request) {
	st := h.assetsStack()
	if st == nil {
		http.Error(w, "assets not configured", http.StatusServiceUnavailable)
		return
	}
	writeJSON(w, st.Index())
}

func (h *Hub) handlePackFile(w http.ResponseWriter, r *http.Request) {
	st := h.assetsStack()
	if st == nil {
		http.Error(w, "assets not configured", http.StatusServiceUnavailable)
		return
	}
	packID := r.PathValue("packId")
	rel := r.PathValue("path")
	if packID == "" || rel == "" {
		http.NotFound(w, r)
		return
	}
	// Reject traversal before hitting the stack — covers encoded and raw forms.
	if _, err := assets.NormalizePath(rel); err != nil {
		http.Error(w, err.Error(), http.StatusBadRequest)
		return
	}
	data, ct, err := st.PackFile(packID, rel)
	if err != nil {
		if strings.Contains(err.Error(), "traversal") || strings.Contains(err.Error(), "absolute") || strings.Contains(err.Error(), "empty path") {
			http.Error(w, err.Error(), http.StatusBadRequest)
			return
		}
		http.NotFound(w, r)
		return
	}
	w.Header().Set("Content-Type", ct)
	_, _ = w.Write(data)
}

func (h *Hub) handleAsset(w http.ResponseWriter, r *http.Request) {
	st := h.assetsStack()
	if st == nil {
		http.Error(w, "assets not configured", http.StatusServiceUnavailable)
		return
	}
	// The stream attaches before pack ingest finishes, so its refreshLang can
	// see a nil stack once and give up (run 26 shipped raw translate keys that
	// way). Asset requests, by construction, only fire when the stack exists —
	// re-check here; the pointer compare makes repeats free.
	h.refreshLang()
	rel := r.PathValue("path")
	if rel == "" {
		http.NotFound(w, r)
		return
	}
	if _, err := assets.NormalizePath(rel); err != nil {
		http.Error(w, err.Error(), http.StatusBadRequest)
		return
	}
	_, data, ct, err := st.Resolve(rel)
	if err != nil {
		if strings.Contains(err.Error(), "traversal") || strings.Contains(err.Error(), "absolute") || strings.Contains(err.Error(), "empty path") {
			http.Error(w, err.Error(), http.StatusBadRequest)
			return
		}
		http.NotFound(w, r)
		return
	}
	w.Header().Set("Content-Type", ct)
	_, _ = w.Write(data)
}

func (h *Hub) assetsStack() *assets.Stack {
	if h == nil || h.assets == nil {
		return nil
	}
	return h.assets.Stack()
}
