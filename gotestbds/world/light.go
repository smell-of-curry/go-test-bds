package world

import (
	"github.com/df-mc/dragonfly/server/world"
	"github.com/df-mc/dragonfly/server/world/chunk"
)

// EnsureColumnLight runs dragonfly light propagation for a complete column when
// it is dirty. Safe to call every snapshot tick — no-ops when clean or incomplete.
//
// Dragonfly's two-stage contract: Fill is a SINGLE-chunk stage (sky columns are
// seeded from that chunk's own heightmap — LightArea.Fill only heightmap-seeds
// c[0], so filling a 3×3 lights nothing but the corner), and Spread is the
// cross-chunk 3×3 stage run after every member chunk has been filled.
//
// @param pos The column to fill.
// @returns true when fill or spread work was performed.
func (w *World) EnsureColumnLight(pos world.ChunkPos) bool {
	col, ok := w.Chunk(pos)
	if !ok || col.State != ColumnComplete {
		return false
	}
	worked := false
	if col.lightDirty {
		w.fillColumnLight(pos, col)
		worked = true
	}
	if !col.lightSpread && w.spreadColumnLight(pos, col) {
		worked = true
	}
	return worked
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
	col.lightSpread = false
}

// fillColumnLight runs the dragonfly Fill stage over the single chunk at pos:
// vertical sky light from the chunk's heightmap plus in-chunk block light.
//
// @param pos Centre column position.
// @param col Centre column (must be ColumnComplete).
func (w *World) fillColumnLight(pos world.ChunkPos, col *Column) {
	restore := func() {}
	if w.hashedIDs {
		restore = remapChunksHashesToLocal([]*chunk.Chunk{col.Chunk})
	}
	chunk.LightArea([]*chunk.Chunk{col.Chunk}, int(pos[0]), int(pos[1])).Fill()
	restore()

	col.lightDirty = false
	col.lightSpread = false
	col.Revision++
}

// spreadColumnLight runs the dragonfly Spread stage over the 3×3 neighbourhood
// centred on pos, once every neighbour is a real, complete, already-filled
// column. Spread only pushes light from brighter cells into darker ones, so
// running it never darkens the centre.
//
// ponytail: neighbours whose light Spread rewrites in place do not get a
// Revision bump — that re-sent up to 8 columns per spread and blew
// ColumnBudget. They pick up edge light when they fill/spread themselves.
//
// @param pos Centre column position.
// @param col Centre column (must be ColumnComplete).
// @returns true when the spread ran.
func (w *World) spreadColumnLight(pos world.ChunkPos, col *Column) bool {
	chunks := make([]*chunk.Chunk, 9)
	for dz := 0; dz < 3; dz++ {
		for dx := 0; dx < 3; dx++ {
			p := world.ChunkPos{pos[0] - 1 + int32(dx), pos[1] - 1 + int32(dz)}
			n, ok := w.Chunk(p)
			if !ok || n.State != ColumnComplete || n.lightDirty {
				return false
			}
			chunks[dx+dz*3] = n.Chunk
		}
	}

	restore := func() {}
	if w.hashedIDs {
		restore = remapChunksHashesToLocal(chunks)
	}
	chunk.LightArea(chunks, int(pos[0]-1), int(pos[1]-1)).Spread()
	restore()

	col.lightSpread = true
	col.Revision++
	return true
}

// remapChunksHashesToLocal rewrites palette entries from network hashes to local
// runtime IDs so LightBlock/FilteringBlock do not index out of range. Returns a
// restore func that puts the hashes back.
//
// @param chunks The chunk slice to remap.
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
