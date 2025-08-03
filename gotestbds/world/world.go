package world

import (
	"github.com/df-mc/dragonfly/server/block"
	"github.com/df-mc/dragonfly/server/block/cube"
	"github.com/df-mc/dragonfly/server/world"
	"github.com/df-mc/dragonfly/server/world/chunk"
	"iter"
	"maps"
)

// World stores all entities & blocks.
type World struct {
	entities map[uint64]Entity
	players  map[string]Entity

	currentChunkPos world.ChunkPos
	currentChunk    *chunk.Chunk

	chunks map[world.ChunkPos]*chunk.Chunk
}

// NewWorld ...
func NewWorld() *World {
	return &World{
		entities: make(map[uint64]Entity),
		players:  make(map[string]Entity),
		chunks:   make(map[world.ChunkPos]*chunk.Chunk),
	}
}

// Chunks returns all chunks.
func (w *World) Chunks() iter.Seq2[world.ChunkPos, *chunk.Chunk] {
	return func(yield func(world.ChunkPos, *chunk.Chunk) bool) {
		for pos, ch := range w.chunks {
			if !yield(pos, ch) {
				return
			}
		}
	}
}

// Entity ...
func (w *World) Entity(rid uint64) (Entity, bool) {
	ent, ok := w.entities[rid]
	return ent, ok
}

// AddEntity ...
func (w *World) AddEntity(ent Entity) {
	w.entities[ent.RuntimeID()] = ent
	if ent.Type() == "minecraft:player" {
		name := ent.(interface{ Name() string }).Name()
		w.players[name] = ent
	}
}

// RemoveEntity ...
func (w *World) RemoveEntity(ent Entity) {
	delete(w.entities, ent.RuntimeID())
	if ent.Type() == "minecraft:player" {
		name := ent.(interface{ Name() string }).Name()
		delete(w.players, name)
	}
}

func (w *World) Player(nick string) (Entity, bool) {
	pl, ok := w.players[nick]
	return pl, ok
}

// Entities ...
func (w *World) Entities() iter.Seq[Entity] {
	return maps.Values(w.entities)
}

// Chunk ...
func (w *World) Chunk(pos world.ChunkPos) (*chunk.Chunk, bool) {
	ch, ok := w.chunks[pos]
	return ch, ok
}

// AddChunk ...
func (w *World) AddChunk(pos world.ChunkPos, c *chunk.Chunk) {
	w.chunks[pos] = c
}

// RemoveChunk is called when chunk is too far away and don't fit in chunk radius.
func (w *World) RemoveChunk(pos world.ChunkPos) {
	delete(w.chunks, pos)
}

// Block reads a block from the position passed. If the chunk is not yet loaded
// at that position air will bee returned.
func (w *World) Block(pos cube.Pos) world.Block {
	return w.block(pos, 0)
}

// Liquid reads liquid from the position passed. If the chunk is not yet loaded
// at the position or there are no water nil, false will be returned.
func (w *World) Liquid(pos cube.Pos) (world.Liquid, bool) {
	b := w.block(pos, 0)
	if liq, ok := b.(world.Liquid); ok {
		return liq, true
	}

	liq, ok := w.block(pos, 1).(world.Liquid)
	return liq, ok
}

// block returns block from the pos & layer of the chunk or air if not succeed.
func (w *World) block(pos cube.Pos, layer uint8) world.Block {
	c := w.chunk(chunkPosFromBlockPos(pos))
	if c == nil || pos.OutOfBounds(c.Range()) {
		return block.Air{}
	}
	rid := c.Block(uint8(pos[0]), int16(pos[1]), uint8(pos[2]), layer)

	bl, _ := world.BlockByRuntimeID(rid)
	return bl
}

// chunk returns *chunk.Chunk or nil.
func (w *World) chunk(pos world.ChunkPos) *chunk.Chunk {
	if w.currentChunkPos == pos {
		return w.currentChunk
	}
	ch := w.chunks[pos]
	w.currentChunk = ch
	w.currentChunkPos = pos
	return ch
}

// SetBlock writes a block to the position passed. If a chunk is not yet loaded
// at that position, operation will be ignored.
func (w *World) SetBlock(pos cube.Pos, b world.Block) {
	c := w.chunk(chunkPosFromBlockPos(pos))
	if c == nil || pos.OutOfBounds(c.Range()) {
		return
	}
	rid := world.BlockRuntimeID(b)
	x, y, z := uint8(pos[0]), int16(pos[1]), uint8(pos[2])

	c.SetBlock(x, y, z, 0, rid)
}

// chunkPosFromBlockPos ...
func chunkPosFromBlockPos(p cube.Pos) world.ChunkPos {
	return world.ChunkPos{int32(p[0] >> 4), int32(p[2] >> 4)}
}
