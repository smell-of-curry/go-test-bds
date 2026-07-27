package viewer

import (
	"context"
	"errors"
	"fmt"
	"log/slog"
	"net"
	"net/http"
	"sync"
	"time"
)

// Options configures the viewer Hub.
type Options struct {
	Address     string // bind address
	Radius      int    // column radius carried by the stream
	ArtifactDir string // where artefacts are written
	AppDir      string // built viewer app to serve at "/", optional
	Logger      *slog.Logger
}

// Hub is the process-wide viewer server. All bots share one Hub; streams are
// selected by bot name.
type Hub struct {
	opts Options
	log  *slog.Logger

	ln   net.Listener
	srv  *http.Server
	addr string

	mu      sync.Mutex
	streams map[string]*Stream
	meta    map[string]botMeta

	arts *artifactStore
}

type botMeta struct {
	tick      uint64
	dimension int32
	attached  int
}

// New binds the listener and starts serving.
//
// @param opts Hub options.
// @returns the running Hub.
// @throws if the address cannot be bound or the artefact directory cannot be created.
func New(opts Options) (*Hub, error) {
	if opts.Address == "" {
		opts.Address = "127.0.0.1:24680"
	}
	if opts.Radius <= 0 {
		opts.Radius = 4
	}
	if opts.Logger == nil {
		opts.Logger = slog.Default()
	}

	arts, err := newArtifactStore(opts.ArtifactDir)
	if err != nil {
		return nil, err
	}

	ln, err := net.Listen("tcp", opts.Address)
	if err != nil {
		return nil, err
	}

	h := &Hub{
		opts:    opts,
		log:     opts.Logger,
		ln:      ln,
		addr:    ln.Addr().String(),
		streams: make(map[string]*Stream),
		meta:    make(map[string]botMeta),
		arts:    arts,
	}
	h.srv = &http.Server{Handler: h.routes()}
	go func() {
		if err := h.srv.Serve(ln); err != nil && !errors.Is(err, http.ErrServerClosed) {
			h.log.Error("viewer http", "error", err)
		}
	}()
	return h, nil
}

// Close shuts down the HTTP server.
func (h *Hub) Close() error {
	ctx, cancel := context.WithTimeout(context.Background(), 5*time.Second)
	defer cancel()
	return h.srv.Shutdown(ctx)
}

// Addr returns the resolved listen address (useful when the port was 0).
func (h *Hub) Addr() string {
	return h.addr
}

// Register creates (or returns) the stream for botName.
func (h *Hub) Register(botName string) *Stream {
	h.mu.Lock()
	defer h.mu.Unlock()
	if s, ok := h.streams[botName]; ok {
		return s
	}
	s := newStream(h, botName, h.opts.Radius)
	h.streams[botName] = s
	h.meta[botName] = botMeta{}
	return s
}

// Unregister drops the stream for botName.
func (h *Hub) Unregister(botName string) {
	h.mu.Lock()
	defer h.mu.Unlock()
	delete(h.streams, botName)
	delete(h.meta, botName)
}

// Attached returns the subscriber count for botName.
func (h *Hub) Attached(botName string) int {
	h.mu.Lock()
	s := h.streams[botName]
	h.mu.Unlock()
	if s == nil {
		return 0
	}
	return s.Attached()
}

// Mark records run context for artefact paths and broadcasts to every stream.
func (h *Hub) Mark(m Mark) {
	h.arts.setMarkContext(m)
	h.mu.Lock()
	streams := make([]*Stream, 0, len(h.streams))
	for _, s := range h.streams {
		streams = append(streams, s)
	}
	h.mu.Unlock()
	for _, s := range streams {
		s.emitMark(m)
	}
}

// Capture requests a still from the harness attached to botName.
//
// Returns immediately with an error containing "no subscriber attached" when
// nobody is rendering — a test that asks for a frame with nobody watching must
// fail fast rather than sit on a context deadline.
//
// @param ctx Cancelled to abandon a pending capture.
// @param botName Bot whose stream should receive the capture frame.
// @param label Free-text label slugged into the artefact filename.
// @param minTick Harness must render a frame at or after this tick.
// @returns the written Artifact.
// @throws when no subscriber is attached, the harness reports an error, or ctx expires.
func (h *Hub) Capture(ctx context.Context, botName, label string, minTick uint64) (Artifact, error) {
	h.mu.Lock()
	s := h.streams[botName]
	h.mu.Unlock()
	if s == nil || s.Attached() == 0 {
		// Fail before waiting on ctx: a 20 s timeout here would change the
		// test's verdict from "viewer missing" into "instruction hung".
		return Artifact{}, fmt.Errorf("viewer: no subscriber attached")
	}

	// Hand the harness this call's own deadline rather than letting it invent
	// one: a caller asking for 20 s would otherwise be failed at the harness's
	// default while this side was still willing to wait.
	var timeoutMs int64
	if deadline, ok := ctx.Deadline(); ok {
		timeoutMs = time.Until(deadline).Milliseconds()
	}

	id := h.arts.nextCaptureID()
	ch := h.arts.beginCapture(id)
	s.emitCapture(id, label, minTick, timeoutMs)

	select {
	case <-ctx.Done():
		h.arts.failCapture(id, ctx.Err().Error())
		return Artifact{}, ctx.Err()
	case res := <-ch:
		return res.art, res.err
	}
}

// PullArtifacts drains artefacts written since the last pull.
func (h *Hub) PullArtifacts() []Artifact {
	return h.arts.pull()
}

func (h *Hub) stream(name string) *Stream {
	h.mu.Lock()
	defer h.mu.Unlock()
	return h.streams[name]
}

func (h *Hub) streamNames() []string {
	h.mu.Lock()
	defer h.mu.Unlock()
	names := make([]string, 0, len(h.streams))
	for name := range h.streams {
		names = append(names, name)
	}
	return names
}

func (h *Hub) setBotMeta(name string, tick uint64, dim int32) {
	h.mu.Lock()
	defer h.mu.Unlock()
	m := h.meta[name]
	m.tick = tick
	m.dimension = dim
	h.meta[name] = m
}

func (h *Hub) setAttached(name string, n int) {
	h.mu.Lock()
	defer h.mu.Unlock()
	m := h.meta[name]
	m.attached = n
	h.meta[name] = m
}

func (h *Hub) botInfos() []BotInfo {
	h.mu.Lock()
	defer h.mu.Unlock()
	out := make([]BotInfo, 0, len(h.streams))
	for name := range h.streams {
		m := h.meta[name]
		out = append(out, BotInfo{
			Name:      name,
			Tick:      m.tick,
			Dimension: m.dimension,
			Attached:  m.attached,
		})
	}
	return out
}
