package viewer

import (
	"bufio"
	"bytes"
	"encoding/json"
	"os"
	"path/filepath"
	"sort"
	"strings"
	"sync"
	"time"

	"github.com/sandertv/gophertunnel/minecraft/protocol"
	"github.com/smell-of-curry/go-test-bds/gotestbds/assets"
)

// recorder writes the same SSE bytes GET /stream would, plus take metadata.
// The subscriber is read on its own goroutine so a slow disk never stalls Tick.
// Falling behind uses the stream's normal newest-frame / keyframe-resync path.
type recorder struct {
	dir      string
	cacheDir string
	baseline string
	start    time.Time
	logger   logger

	mu      sync.Mutex
	stopped bool
	done    chan struct{}
	wg      sync.WaitGroup
	bots    []string
}

type logger interface {
	Warn(msg string, args ...any)
}

func newRecorder(opts Options) *recorder {
	return &recorder{
		dir:      opts.RecordDir,
		cacheDir: opts.CacheDir,
		baseline: opts.BaselineTag,
		start:    time.Now().UTC(),
		done:     make(chan struct{}),
		logger:   opts.Logger,
	}
}

func (r *recorder) follow(s *Stream) {
	r.mu.Lock()
	if r.stopped {
		r.mu.Unlock()
		return
	}
	r.wg.Add(1)
	r.bots = append(r.bots, s.name)
	r.mu.Unlock()

	path := filepath.Join(r.dir, recordFileName(s.name))
	f, err := os.Create(path)
	if err != nil {
		if r.logger != nil {
			r.logger.Warn("record open", "bot", s.name, "error", err)
		}
		r.wg.Done()
		return
	}
	bw := bufio.NewWriterSize(f, 64<<10)
	hello, _ := json.Marshal(Hello{
		V:        SchemaVersion,
		Type:     "hello",
		Bot:      s.name,
		Schema:   SchemaVersion,
		TickRate: TickRate,
		Radius:   s.hub.opts.Radius,
	})
	_, _ = bw.Write(formatSSE("hello", hello))
	_ = bw.Flush()

	sub := s.attach()
	go func() {
		defer r.wg.Done()
		defer s.detach(sub)
		defer func() {
			_ = bw.Flush()
			_ = f.Close()
		}()
		for {
			wrote := drainSSE(sub, bw)
			if wrote {
				_ = bw.Flush()
			}
			select {
			case <-r.done:
				_ = drainSSE(sub, bw)
				return
			case <-sub.wake:
			}
		}
	}()
}

func drainSSE(sub *subscriber, bw *bufio.Writer) bool {
	wrote := false
	for {
		frame, ok := sub.next()
		if !ok {
			return wrote
		}
		_, _ = bw.Write(formatSSE(frame.event, frame.data))
		wrote = true
	}
}

func (r *recorder) writeSkin(hash string, png []byte) {
	r.mu.Lock()
	if r.stopped {
		r.mu.Unlock()
		return
	}
	r.wg.Add(1)
	r.mu.Unlock()
	go func() {
		defer r.wg.Done()
		dir := filepath.Join(r.dir, "skins")
		if err := os.MkdirAll(dir, 0o755); err != nil {
			return
		}
		path := filepath.Join(dir, hash+".png")
		_ = os.WriteFile(path, png, 0o644)
	}()
}

func (r *recorder) stop(h *Hub) {
	r.mu.Lock()
	if r.stopped {
		r.mu.Unlock()
		return
	}
	r.stopped = true
	close(r.done)
	r.mu.Unlock()
	r.wg.Wait()
	r.writeMeta(h)
}

func (r *recorder) writeMeta(h *Hub) {
	if h != nil && h.assets != nil {
		r.mu.Lock()
		if d := h.assets.CacheDir(); d != "" {
			r.cacheDir = d
		}
		if tag := h.assets.BaselineTag(); tag != "" {
			r.baseline = tag
		}
		r.mu.Unlock()
	}
	r.writePacks(h)
	r.writeTake()
}

func (r *recorder) writePacks(h *Hub) {
	packs := []assets.Info{}
	if h != nil {
		if st := h.assetsStack(); st != nil {
			if p := st.Packs(); p != nil {
				packs = p
			}
		}
	}
	var buf bytes.Buffer
	enc := json.NewEncoder(&buf)
	_ = enc.Encode(packs)
	_ = os.WriteFile(filepath.Join(r.dir, "packs.json"), buf.Bytes(), 0o644)
}

func (r *recorder) writeTake() {
	r.mu.Lock()
	bots := append([]string(nil), r.bots...)
	cache, baseline := r.cacheDir, r.baseline
	start := r.start
	r.mu.Unlock()
	sort.Strings(bots)
	// Drop duplicate names from a re-register.
	if len(bots) > 1 {
		uniq := bots[:1]
		for _, name := range bots[1:] {
			if name != uniq[len(uniq)-1] {
				uniq = append(uniq, name)
			}
		}
		bots = uniq
	}
	if bots == nil {
		bots = []string{}
	}
	body, err := json.MarshalIndent(takeFile{
		CacheDir:    cache,
		BaselineTag: baseline,
		Bots:        bots,
		StartTime:   start.Format(time.RFC3339),
		Protocol:    protocol.CurrentVersion,
	}, "", "  ")
	if err != nil {
		return
	}
	body = append(body, '\n')
	_ = os.WriteFile(filepath.Join(r.dir, "take.json"), body, 0o644)
}

type takeFile struct {
	CacheDir    string   `json:"cacheDir"`
	BaselineTag string   `json:"baselineTag"`
	Bots        []string `json:"bots"`
	StartTime   string   `json:"startTime"`
	Protocol    string   `json:"protocol"`
}

func recordFileName(bot string) string {
	bot = strings.ReplaceAll(bot, "/", "_")
	bot = strings.ReplaceAll(bot, "\\", "_")
	if bot == "" || bot == "." || bot == ".." {
		bot = "bot"
	}
	return bot + ".sse"
}
