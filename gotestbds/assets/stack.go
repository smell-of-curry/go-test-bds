package assets

import (
	"fmt"
	"sync"
)

// StackEntry is one pack on the resolved stack, in apply order.
type StackEntry struct {
	UUID        string
	Version     string
	SubPackName string
	Dir         string // extracted pack root on disk
	ID          string // "vanilla" or uuid
}

// Stack is the merged resource pack stack: vanilla at priority 0, then server
// packs in ResourcePackStack order (first applied first). Later packs win on
// path collisions — that is the client's precedence rule, taken from
// packet.ResourcePackStack's documented apply order.
type Stack struct {
	mu    sync.RWMutex
	packs []*Pack
	index map[string]string // path → winning pack id
}

// BuildStack opens each entry and builds the merged file index.
//
// Precedence evidence: gophertunnel packet.ResourcePackStack says "The first
// in the list will be applied first." Combined with vanilla as the permanent
// lowest layer, a path defined by a later pack overrides an earlier one. The
// fixture test TestStackServerPackWins locks that in.
//
// @param entries Ordered lowest-priority first (vanilla, then stack order).
// @param deviceTier Memory performance tier for subpack selection.
// @returns the built Stack.
// @throws when a pack cannot be opened.
func BuildStack(entries []StackEntry, deviceTier int) (*Stack, error) {
	s := &Stack{index: make(map[string]string)}
	for i, e := range entries {
		id := e.ID
		if id == "" {
			id = e.UUID
		}
		p, err := OpenPack(id, e.Dir, i, deviceTier, e.SubPackName)
		if err != nil {
			return nil, fmt.Errorf("assets: open pack %s: %w", id, err)
		}
		if e.UUID != "" {
			p.UUID = e.UUID
		}
		if e.Version != "" {
			p.Version = e.Version
		}
		s.packs = append(s.packs, p)
		for path := range p.files {
			s.index[path] = p.ID
		}
	}
	return s, nil
}

// Packs returns pack infos in apply order (lowest priority first).
func (s *Stack) Packs() []Info {
	s.mu.RLock()
	defer s.mu.RUnlock()
	out := make([]Info, len(s.packs))
	for i, p := range s.packs {
		out[i] = p.Info()
	}
	return out
}

// Index returns the merged path → packId map.
func (s *Stack) Index() map[string]string {
	s.mu.RLock()
	defer s.mu.RUnlock()
	out := make(map[string]string, len(s.index))
	for k, v := range s.index {
		out[k] = v
	}
	return out
}

// Resolve returns the winning pack id and bytes for a path.
//
// @param packPath Pack-relative path.
// @returns packId, bytes, content-type.
// @throws when the path is invalid or no pack has it.
func (s *Stack) Resolve(packPath string) (packID string, data []byte, contentType string, err error) {
	norm, err := NormalizePath(packPath)
	if err != nil {
		return "", nil, "", err
	}
	s.mu.RLock()
	defer s.mu.RUnlock()
	packID, ok := s.index[norm]
	if !ok {
		return "", nil, "", fmt.Errorf("assets: no pack has %q", packPath)
	}
	for _, p := range s.packs {
		if p.ID != packID {
			continue
		}
		data, err = p.ReadFile(norm)
		if err != nil {
			return "", nil, "", err
		}
		return packID, data, ContentType(norm), nil
	}
	return "", nil, "", fmt.Errorf("assets: pack %s missing from stack", packID)
}

// PackFile returns bytes from a specific pack.
//
// @param packID Pack id.
// @param packPath Pack-relative path.
// @returns bytes and content type.
// @throws when the pack or path is absent, or the path is unsafe.
func (s *Stack) PackFile(packID, packPath string) ([]byte, string, error) {
	norm, err := NormalizePath(packPath)
	if err != nil {
		return nil, "", err
	}
	s.mu.RLock()
	defer s.mu.RUnlock()
	for _, p := range s.packs {
		if p.ID != packID {
			continue
		}
		data, err := p.ReadFile(norm)
		if err != nil {
			return nil, "", err
		}
		return data, ContentType(norm), nil
	}
	return nil, "", fmt.Errorf("assets: unknown pack %q", packID)
}

// Winner returns the pack id that owns path, or "".
func (s *Stack) Winner(packPath string) string {
	norm, err := NormalizePath(packPath)
	if err != nil {
		return ""
	}
	s.mu.RLock()
	defer s.mu.RUnlock()
	return s.index[norm]
}
