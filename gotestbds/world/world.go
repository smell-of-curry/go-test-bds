package world

import (
	"iter"
	"maps"

	_ "unsafe"

	"github.com/df-mc/dragonfly/server/block"
	"github.com/df-mc/dragonfly/server/block/cube"
	"github.com/df-mc/dragonfly/server/world"
	"github.com/df-mc/dragonfly/server/world/chunk"
)

// blockRegistry is the registry block IDs are resolved against. It is the same
// vanilla registry the bot decodes chunks with.
var blockRegistry = world.DefaultBlockRegistry

// World stores all entities & blocks.
type World struct {
	entities map[uint64]Entity
	players  map[string]Entity

	currentChunkPos world.ChunkPos
	currentChunk    *Column

	chunks map[world.ChunkPos]*Column

	// hashedIDs mirrors the server's UseBlockNetworkIDHashes game data flag.
	hashedIDs bool
}

// NewWorld creates a world holding the blocks and entities a bot knows about.
//
// @param hashedRuntimeIDs Whether the server identifies blocks on the wire by
// their network hash rather than by their index in the block palette. BDS sets
// this by default (`block-network-ids-are-hashes=true`).
// @returns the empty world.
func NewWorld(hashedRuntimeIDs bool) *World {
	// Hash lookups panic on a registry that was never finalized. Finalize is
	// idempotent, so claiming it here costs nothing and keeps a bare NewWorld
	// (tests, tools) usable.
	blockRegistry.Finalize()
	return &World{
		entities:  make(map[uint64]Entity),
		players:   make(map[string]Entity),
		chunks:    make(map[world.ChunkPos]*Column),
		hashedIDs: hashedRuntimeIDs,
	}
}

// Chunks returns all chunks.
func (w *World) Chunks() iter.Seq2[world.ChunkPos, *chunk.Chunk] {
	return func(yield func(world.ChunkPos, *chunk.Chunk) bool) {
		for pos, ch := range w.chunks {
			if !yield(pos, ch.Chunk) {
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
		name, ok := ent.(interface{ Name() string })
		if ok {
			w.players[name.Name()] = ent
		}
	}
}

// RemoveEntity ...
func (w *World) RemoveEntity(ent Entity) {
	delete(w.entities, ent.RuntimeID())
	if ent.Type() == "minecraft:player" {
		name, ok := ent.(interface{ Name() string })
		if ok {
			delete(w.players, name.Name())
		}
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
func (w *World) Chunk(pos world.ChunkPos) (*Column, bool) {
	ch, ok := w.chunks[pos]
	return ch, ok
}

// AddChunk ...
func (w *World) AddChunk(pos world.ChunkPos, c *Column) {
	w.chunks[pos] = c
	// The one-entry lookup cache starts out holding chunk 0, 0 with no column, so
	// a world whose first read is in that chunk reads it as empty forever.
	if w.currentChunkPos == pos {
		w.currentChunk = c
	}
}

// RemoveChunk is called when chunk is too far away and don't fit in chunk radius.
func (w *World) RemoveChunk(pos world.ChunkPos) {
	delete(w.chunks, pos)
	if w.currentChunkPos == pos {
		w.currentChunk = nil
	}
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
	rid := w.decodeRuntimeID(c.Block(uint8(pos[0]), int16(pos[1]), uint8(pos[2]), layer))
	if layer == 0 && isNbtBlock(rid) {
		bl, ok := c.BlockEntities[pos]
		if ok {
			return bl
		}
	}

	bl, ok := world.BlockByRuntimeID(rid)
	if !ok {
		return UnknownBlock{}
	}
	return bl
}

// decodeRuntimeID turns an ID as it arrived over the network into one this
// bot's block registry understands.
//
// With `block-network-ids-are-hashes` (the BDS default) a palette entry is an
// FNV hash of the block state, not an index into the palette, so reading it as
// a runtime ID names every block "unknown" — the bot then can't see the floor
// it stands on or the block a test just placed.
//
// @param rid The ID read out of a chunk or block update.
// @returns the local runtime ID, or the input unchanged when it is already one.
func (w *World) decodeRuntimeID(rid uint32) uint32 {
	if !w.hashedIDs {
		return rid
	}
	if local, ok := blockRegistry.HashToRuntimeID(rid); ok {
		return local
	}
	// Blocks the bot wrote itself (its own optimistic placements) are stored as
	// plain runtime IDs, so fall through rather than losing them.
	return rid
}

// chunk returns *chunk.Chunk or nil.
func (w *World) chunk(pos world.ChunkPos) *Column {
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
	w.SetBlockOnTheLayer(pos, b, 0)
}

// SetBlockOnTheLayer ...
func (w *World) SetBlockOnTheLayer(pos cube.Pos, b world.Block, layer uint32) {
	c := w.chunk(chunkPosFromBlockPos(pos))
	if c == nil || pos.OutOfBounds(c.Range()) {
		return
	}
	rid := world.BlockRuntimeID(b)
	x, y, z := uint8(pos[0]), int16(pos[1]), uint8(pos[2])
	if layer == 0 && isNbtBlock(rid) {
		c.BlockEntities[pos] = b
	}

	c.SetBlock(x, y, z, uint8(layer), rid)
}

// SetBlockRuntimeID writes a block by its network runtime ID, without decoding
// it first.
//
// A server running an addon sends runtime IDs for blocks this bot's registry has
// never heard of. Decoding those first loses them — they come back as air, and a
// floor of them is one a bot falls through — so a block update the bot cannot
// name is still worth storing exactly as it arrived.
//
// @param pos The block position.
// @param rid The block's network runtime ID.
// @param layer The chunk layer to write to.
func (w *World) SetBlockRuntimeID(pos cube.Pos, rid uint32, layer uint32) {
	c := w.chunk(chunkPosFromBlockPos(pos))
	if c == nil || pos.OutOfBounds(c.Range()) {
		return
	}

	if local := w.decodeRuntimeID(rid); layer == 0 && isNbtBlock(local) {
		if b, ok := world.BlockByRuntimeID(local); ok {
			c.BlockEntities[pos] = b
		}
	}
	c.SetBlock(uint8(pos[0]), int16(pos[1]), uint8(pos[2]), uint8(layer), rid)
}

// chunkPosFromBlockPos ...
func chunkPosFromBlockPos(p cube.Pos) world.ChunkPos {
	return world.ChunkPos{int32(p[0] >> 4), int32(p[2] >> 4)}
}

//go:linkname nbtBlocks github.com/df-mc/dragonfly/server/world.nbtBlocks
var nbtBlocks []bool

// isNbtBlock returns whether the block does contain nbt.
func isNbtBlock(rid uint32) bool {
	if len(nbtBlocks) < int(rid+1) {
		return false
	}
	return nbtBlocks[rid]
}
