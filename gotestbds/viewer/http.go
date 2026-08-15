package viewer

import (
	"encoding/json"
	"fmt"
	"io"
	"net/http"
	"net/http/pprof"
	"strconv"
	"time"
)

func (h *Hub) routes() http.Handler {
	mux := http.NewServeMux()
	mux.HandleFunc("GET /stream", h.handleStream)
	mux.HandleFunc("GET /bots", h.handleBots)
	mux.HandleFunc("GET /health", h.handleHealth)
	mux.HandleFunc("GET /packs", h.handlePacks)
	mux.HandleFunc("GET /packs/index", h.handlePacksIndex)
	mux.HandleFunc("GET /pack/{packId}/{path...}", h.handlePackFile)
	mux.HandleFunc("GET /asset/{path...}", h.handleAsset)
	mux.HandleFunc("GET /", h.handleRoot)
	mux.HandleFunc("POST /artifact", h.handleArtifact)
	mux.HandleFunc("POST /capture/{id}/error", h.handleCaptureError)
	// Live goroutine/heap dumps for diagnosing a hung bot from outside —
	// the hub listens on loopback only, so exposure matches the stream.
	mux.HandleFunc("GET /debug/pprof/", pprof.Index)
	mux.HandleFunc("GET /debug/pprof/profile", pprof.Profile)
	return mux
}

func (h *Hub) handleStream(w http.ResponseWriter, r *http.Request) {
	bot := r.URL.Query().Get("bot")
	names := h.streamNames()
	if bot == "" {
		if len(names) != 1 {
			http.Error(w, "bot query required when multiple bots are registered", http.StatusNotFound)
			return
		}
		bot = names[0]
	}
	s := h.stream(bot)
	if s == nil {
		http.Error(w, "unknown bot", http.StatusNotFound)
		return
	}
	// By the time a viewer attaches, the bot's packs are ingested — the lang
	// table can resolve translate keys the way a real client would.
	h.refreshLang()

	flusher, ok := w.(http.Flusher)
	if !ok {
		http.Error(w, "streaming unsupported", http.StatusInternalServerError)
		return
	}

	w.Header().Set("Content-Type", "text/event-stream")
	w.Header().Set("Cache-Control", "no-cache")
	w.Header().Set("Connection", "keep-alive")

	hello, _ := json.Marshal(Hello{
		V:        SchemaVersion,
		Type:     "hello",
		Bot:      bot,
		Schema:   SchemaVersion,
		TickRate: TickRate,
		Radius:   h.opts.Radius,
	})
	writeSSE(w, "hello", hello)
	flusher.Flush()

	sub := s.attach()
	defer s.detach(sub)

	keepalive := time.NewTicker(15 * time.Second)
	defer keepalive.Stop()

	ctx := r.Context()
	for {
		// Drain everything queued before waiting again: one wake can cover
		// several frames, and a world frame that arrived while an event was
		// being written is still worth sending.
		for {
			frame, ok := sub.next()
			if !ok {
				break
			}
			writeSSE(w, frame.event, frame.data)
			flusher.Flush()
		}

		select {
		case <-ctx.Done():
			return
		case <-keepalive.C:
			_, _ = io.WriteString(w, ": keepalive\n\n")
			flusher.Flush()
		case <-sub.wake:
		}
	}
}

func writeSSE(w http.ResponseWriter, event string, data []byte) {
	_, _ = fmt.Fprintf(w, "event: %s\ndata: %s\n\n", event, data)
}

func (h *Hub) handleBots(w http.ResponseWriter, _ *http.Request) {
	writeJSON(w, map[string]any{"v": SchemaVersion, "bots": h.botInfos()})
}

func (h *Hub) handleHealth(w http.ResponseWriter, _ *http.Request) {
	writeJSON(w, map[string]any{"v": SchemaVersion, "ok": true, "bots": h.botInfos()})
}

func (h *Hub) handleRoot(w http.ResponseWriter, r *http.Request) {
	if h.opts.AppDir != "" {
		// The whole build, not just index.html: the app is a bundle plus the
		// assets it loads, and serving the page without its script produces a
		// blank canvas that is indistinguishable from a viewer which connected
		// and rendered nothing.
		http.FileServer(http.Dir(h.opts.AppDir)).ServeHTTP(w, r)
		return
	}
	if r.URL.Path != "/" {
		http.NotFound(w, r)
		return
	}
	w.Header().Set("Content-Type", "text/plain; charset=utf-8")
	_, _ = io.WriteString(w, "go-test-bds viewer: build the web app and pass --viewer-app <dir>, or open GET /stream?bot=<name>\n")
}

func (h *Hub) handleArtifact(w http.ResponseWriter, r *http.Request) {
	kind := r.Header.Get("X-Artifact-Kind")
	ext := r.Header.Get("X-Artifact-Ext")
	bot := r.Header.Get("X-Artifact-Bot")
	if kind == "" || ext == "" || bot == "" {
		http.Error(w, "X-Artifact-Kind, X-Artifact-Ext and X-Artifact-Bot are required", http.StatusBadRequest)
		return
	}
	body, err := io.ReadAll(io.LimitReader(r.Body, maxArtifactBytes+1))
	if err != nil {
		http.Error(w, err.Error(), http.StatusBadRequest)
		return
	}
	if len(body) > maxArtifactBytes {
		http.Error(w, "artifact body too large", http.StatusRequestEntityTooLarge)
		return
	}

	meta := Artifact{
		Kind:       kind,
		Ext:        ext,
		Bot:        bot,
		Label:      r.Header.Get("X-Artifact-Label"),
		RunID:      r.Header.Get("X-Artifact-Run"),
		Suite:      r.Header.Get("X-Artifact-Suite"),
		Test:       r.Header.Get("X-Artifact-Test"),
		Tick:       parseUintHeader(r.Header.Get("X-Artifact-Tick")),
		Width:      parseIntHeader(r.Header.Get("X-Artifact-Width")),
		Height:     parseIntHeader(r.Header.Get("X-Artifact-Height")),
		DurationMs: int64(parseIntHeader(r.Header.Get("X-Artifact-Duration-Ms"))),
	}
	art, err := h.arts.writeArtifact(meta, body)
	if err != nil {
		http.Error(w, err.Error(), http.StatusInternalServerError)
		return
	}
	if id := r.Header.Get("X-Capture-Id"); id != "" {
		h.arts.resolveCapture(id, art)
	}
	writeJSON(w, map[string]any{"v": SchemaVersion, "path": art.Path, "bytes": art.Bytes})
}

func (h *Hub) handleCaptureError(w http.ResponseWriter, r *http.Request) {
	id := r.PathValue("id")
	var body struct {
		Message string `json:"message"`
	}
	if err := json.NewDecoder(r.Body).Decode(&body); err != nil {
		http.Error(w, err.Error(), http.StatusBadRequest)
		return
	}
	if body.Message == "" {
		body.Message = "capture failed"
	}
	if !h.arts.failCapture(id, body.Message) {
		http.Error(w, "unknown capture id", http.StatusNotFound)
		return
	}
	w.WriteHeader(http.StatusOK)
}

func writeJSON(w http.ResponseWriter, v any) {
	w.Header().Set("Content-Type", "application/json")
	_ = json.NewEncoder(w).Encode(v)
}

func parseUintHeader(s string) uint64 {
	if s == "" {
		return 0
	}
	n, _ := strconv.ParseUint(s, 10, 64)
	return n
}

func parseIntHeader(s string) int {
	if s == "" {
		return 0
	}
	n, _ := strconv.Atoi(s)
	return n
}
