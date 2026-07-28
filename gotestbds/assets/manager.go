package assets

import (
	"context"
	"fmt"
	"log/slog"
	"path/filepath"
	"strings"
	"sync"

	"github.com/google/uuid"
	"github.com/sandertv/gophertunnel/minecraft/protocol"
	"github.com/sandertv/gophertunnel/minecraft/resource"
)

// Options configures a Manager.
type Options struct {
	CacheDir              string
	BaselineTag           string
	AcceptServerPacks     bool
	Offline               bool
	MemoryPerformanceTier int // device tier for subpack select; default 5
	Fetcher               Fetcher
	Logger                *slog.Logger
}

// Manager owns the pack cache, vanilla baseline, and live stack.
type Manager struct {
	opts  Options
	cache Cache
	log   *slog.Logger

	mu          sync.RWMutex
	stack       *Stack
	baselineDir string
	stackOrder  []protocol.StackResourcePack
}

// New creates a Manager and ensures the vanilla baseline is present.
// Call only when the viewer is enabled.
//
// @param ctx Cancellation for baseline fetch.
// @param opts Manager options.
// @returns the Manager with vanilla loaded into the stack.
// @throws when the baseline is missing/mismatched and cannot be fetched.
func New(ctx context.Context, opts Options) (*Manager, error) {
	if opts.CacheDir == "" {
		return nil, fmt.Errorf("assets: CacheDir is required")
	}
	if opts.BaselineTag == "" {
		opts.BaselineTag = DefaultBaselineTag
	}
	if opts.MemoryPerformanceTier <= 0 {
		opts.MemoryPerformanceTier = 5
	}
	if opts.Logger == nil {
		opts.Logger = slog.Default()
	}
	m := &Manager{
		opts:  opts,
		cache: Cache{Root: opts.CacheDir},
		log:   opts.Logger,
	}
	dir, err := EnsureBaseline(ctx, opts.CacheDir, opts.BaselineTag, opts.Fetcher, opts.Offline)
	if err != nil {
		return nil, err
	}
	m.baselineDir = dir
	if err := m.rebuildLocked(nil); err != nil {
		return nil, err
	}
	return m, nil
}

// Stack returns the current resolved stack (never nil after New).
func (m *Manager) Stack() *Stack {
	m.mu.RLock()
	defer m.mu.RUnlock()
	return m.stack
}

// SetStackOrder records the ResourcePackStack apply order from the wire.
// Safe to call from PacketFunc.
func (m *Manager) SetStackOrder(packs []protocol.StackResourcePack) {
	m.mu.Lock()
	defer m.mu.Unlock()
	m.stackOrder = append([]protocol.StackResourcePack(nil), packs...)
}

// StackOrder returns the last captured ResourcePackStack texture list.
func (m *Manager) StackOrder() []protocol.StackResourcePack {
	m.mu.RLock()
	defer m.mu.RUnlock()
	return append([]protocol.StackResourcePack(nil), m.stackOrder...)
}

// ShouldDownload reports whether Dialer.DownloadResourcePack should accept a pack.
// Returns false when the viewer is not accepting packs, offline, or the pack is cached.
func (m *Manager) ShouldDownload(id uuid.UUID, version string) bool {
	if m == nil || !m.opts.AcceptServerPacks || m.opts.Offline {
		return false
	}
	return !m.cache.Has(id, version)
}

// IngestServerPacks caches Conn.ResourcePacks() and rebuilds the stack using
// the captured ResourcePackStack order (first applied first). Packs without a
// resources module are skipped — behaviour packs are never an asset source.
//
// @param downloaded Packs from conn.ResourcePacks().
// @throws when a pack cannot be cached or the stack cannot be rebuilt.
func (m *Manager) IngestServerPacks(downloaded []*resource.Pack) error {
	byKey := make(map[string]*resource.Pack, len(downloaded))
	for _, p := range downloaded {
		if p == nil || !p.HasTextures() {
			continue
		}
		if _, err := m.cache.PutPack(p); err != nil {
			return err
		}
		byKey[packKey(p.UUID().String(), p.Version())] = p
	}

	m.mu.Lock()
	defer m.mu.Unlock()

	var serverEntries []StackEntry
	order := m.stackOrder
	if len(order) == 0 {
		// No stack packet captured — fall back to download order.
		for _, p := range downloaded {
			if p == nil || !p.HasTextures() {
				continue
			}
			order = append(order, protocol.StackResourcePack{
				UUID:    p.UUID().String(),
				Version: p.Version(),
			})
		}
	}
	for _, entry := range order {
		id, err := uuid.Parse(entry.UUID)
		if err != nil {
			m.log.Warn("assets: skip stack entry with bad uuid", "uuid", entry.UUID)
			continue
		}
		dir := m.cache.PackDir(id, entry.Version)
		if !m.cache.Has(id, entry.Version) {
			// Exempted / vanilla editor packs and ignored packs are not in
			// our cache; skip rather than failing the whole stack.
			m.log.Debug("assets: stack pack not in cache, skipping", "uuid", entry.UUID, "version", entry.Version)
			continue
		}
		serverEntries = append(serverEntries, StackEntry{
			ID:          strings.ToLower(id.String()),
			UUID:        strings.ToLower(id.String()),
			Version:     entry.Version,
			SubPackName: entry.SubPackName,
			Dir:         dir,
		})
		_ = byKey // kept for future content-key handling
	}
	return m.rebuildLocked(serverEntries)
}

// rebuildLocked rebuilds the stack. Caller must hold m.mu (or be in New).
func (m *Manager) rebuildLocked(server []StackEntry) error {
	entries := []StackEntry{{
		ID:      PackIDVanilla,
		UUID:    PackIDVanilla,
		Version: TagVersion(m.opts.BaselineTag),
		Dir:     filepath.Join(m.baselineDir, "resource_pack"),
	}}
	entries = append(entries, server...)
	st, err := BuildStack(entries, m.opts.MemoryPerformanceTier)
	if err != nil {
		return err
	}
	m.stack = st
	return nil
}

func packKey(id, version string) string {
	return strings.ToLower(id) + "_" + version
}
