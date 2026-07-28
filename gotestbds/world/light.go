package world

import (
	"github.com/df-mc/dragonfly/server/world"
	"github.com/df-mc/dragonfly/server/world/chunk"
)

// EnsureColumnLight runs dragonfly light propagation for a complete column when
// it is dirty. Safe to call every snapshot tick — no-ops when clean or incomplete.
//
// @param pos The column to fill.
func (w *World) EnsureColumnLight(pos world.ChunkPos) {
	col, ok := w.Chunk(pos)
	if !ok || col.State != ColumnComplete || !col.lightDirty {
		return
	}
	w.fillColumnLight(pos, col)
}

// MarkLightDirty queues a light re-fill for the next EnsureColumnLight call.
//
// @param pos The column whose blocks changed.
func (w *World) MarkLightDirty(pos world.ChunkPos) {
	col, ok := w.Chunk(pos)
	if !ok || col.State != ColumnComplete {
		return
	}
	col.lightDirty = true
}

// fillColumnLight runs LightArea Fill+Spread over a 3×3 neighbourhood centred
// on pos and stores sky/block light on the centre column's sub-chunks.
//
// ponytail: missing/incomplete neighbours become empty air placeholders for
// LightArea's square requirement; Spread is skipped unless the full 3×3 is
// ColumnComplete (otherwise open-sky placeholders leak light under platforms).
// Upgrade: keep a dirty ring and re-Spread when neighbours complete.
//
// @param pos Centre column position.
// @param col Centre column (must be ColumnComplete).
func (w *World) fillColumnLight(pos world.ChunkPos, col *Column) {
	r := col.Range()
	chunks := make([]*chunk.Chunk, 9)
	var live [9]*Column
	for dz := 0; dz < 3; dz++ {
		for dx := 0; dx < 3; dx++ {
			p := world.ChunkPos{pos[0] - 1 + int32(dx), pos[1] - 1 + int32(dz)}
			idx := dx + dz*3
			if n, ok := w.Chunk(p); ok && n.Chunk != nil {
				chunks[idx] = n.Chunk
				live[idx] = n
				continue
			}
			chunks[idx] = chunk.New(blockRegistry, r)
		}
	}

	restore := func() {}
	if w.hashedIDs {
		restore = remapChunksHashesToLocal(chunks)
	}
	area := chunk.LightArea(chunks, int(pos[0]-1), int(pos[1]-1))
	area.Fill()
	// Spread only when the full 3×3 is real+complete. Spreading into empty
	// placeholder air chunks (full sky) leaks light under platforms at the
	// loaded frontier — worse than skipping cross-chunk propagation.
	spread := true
	for i, n := range live {
		if i == 4 {
			continue
		}
		if n == nil || n.State != ColumnComplete {
			spread = false
			break
		}
	}
	if spread {
		area.Spread()
	}
	restore()

	col.lightDirty = false
	col.Revision++
	// ponytail: Spread may rewrite neighbour light slices in place, but we do
	// not bump their Revision here — that re-sent up to 8 extra columns per
	// edit and blew ColumnBudget. Neighbours pick up edge light the next time
	// they themselves are filled (block edit / completion).
}

// remapChunksHashesToLocal rewrites palette entries from network hashes to local
// runtime IDs so LightBlock/FilteringBlock do not index out of range. Returns a
// restore func that puts the hashes back.
//
// @param chunks The LightArea chunk slice (may include empty placeholders).
// @returns a function that restores original palette values.
func remapChunksHashesToLocal(chunks []*chunk.Chunk) func() {
	type snap struct {
		palette *chunk.Palette
		values  []uint32
	}
	var snaps []snap
	air := blockRegistry.AirRuntimeID()
	for _, c := range chunks {
		if c == nil {
			continue
		}
		for _, sub := range c.Sub() {
			if sub == nil {
				continue
			}
			for _, layer := range sub.Layers() {
				if layer == nil {
					continue
				}
				pal := layer.Palette()
				orig := make([]uint32, pal.Len())
				for i := 0; i < pal.Len(); i++ {
					orig[i] = pal.Value(uint16(i))
				}
				snaps = append(snaps, snap{palette: pal, values: orig})
				pal.Replace(func(v uint32) uint32 {
					if local, ok := blockRegistry.HashToRuntimeID(v); ok {
						return local
					}
					// Unknown / already-local: keep if in range, else air.
					if int(v) < blockRegistry.BlockCount() {
						return v
					}
					return air
				})
			}
		}
	}
	return func() {
		for _, s := range snaps {
			i := 0
			s.palette.Replace(func(uint32) uint32 {
				v := s.values[i]
				i++
				return v
			})
		}
	}
}
