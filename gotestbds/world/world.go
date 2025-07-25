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

// Block reads a block from the position passed. If a chunk is not yet loaded
// at that position air will bee returned.
func (w *World) Block(pos cube.Pos) world.Block {
	c := w.chunks[chunkPosFromBlockPos(pos)]
	if pos.OutOfBounds(c.Range()) {
		return block.Air{}
	}
	rid := c.Block(uint8(pos[0]), int16(pos[1]), uint8(pos[2]), 0)

	bl, _ := world.BlockByRuntimeID(rid)
	return bl
}

// SetBlock writes a block to the position passed. If a chunk is not yet loaded
// at that position, operation will be ignored.
func (w *World) SetBlock(pos cube.Pos, b world.Block) {
	c, ok := w.chunks[chunkPosFromBlockPos(pos)]
	if !ok || pos.OutOfBounds(c.Range()) {
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
