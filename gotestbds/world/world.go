package world

import (
	"iter"
	"maps"
	"math"

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
	byUnique map[int64]Entity
	players  map[string]Entity

	dimension int32

	currentChunkPos world.ChunkPos
	currentChunk    *Column

	chunks map[int32]map[world.ChunkPos]*Column

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
		byUnique:  make(map[int64]Entity),
		players:   make(map[string]Entity),
		chunks:    make(map[int32]map[world.ChunkPos]*Column),
		hashedIDs: hashedRuntimeIDs,
	}
}

// Dimension returns the dimension columns and block reads currently target.
func (w *World) Dimension() int32 {
	return w.dimension
}

// SetDimension switches the world's current dimension.
//
// Chunk lookups are keyed per dimension; leaving the one-entry cache pointing
// at a column (or a cached nil) from the previous dimension would make the
// same ChunkPos read the wrong world — or hide a column that already exists
// in the new one.
//
// @param dim The dimension ID to make current.
func (w *World) SetDimension(dim int32) {
	if w.dimension == dim {
		return
	}
	w.dimension = dim
	w.invalidateChunkCache()
}

// FlushChunks drops every column in the current dimension.
//
// Used on ChangeDimension: the columns the bot held for the dimension it is
// leaving are not valid in the destination, and keeping them under the old
// key would only waste memory until a later revisit.
func (w *World) FlushChunks() {
	delete(w.chunks, w.dimension)
	w.invalidateChunkCache()
}

// FlushEntities drops every entity except the one with the runtime ID passed.
//
// A dimension change leaves the bot in a world none of the entities it was
// tracking exist in, and the server does not send a RemoveActor for each of
// them — it simply stops mentioning them. Keeping them is the same ghost the
// unique-ID removal fix exists to prevent, one dimension over.
//
// @param keep The runtime ID to preserve, normally the bot's own entity.
func (w *World) FlushEntities(keep uint64) {
	for rid, ent := range w.entities {
		if rid == keep {
			continue
		}
		w.RemoveEntity(ent)
	}
}

// invalidateChunkCache drops the one-entry lookup cache.
//
// The zero ChunkPos {0,0} is a real column, so clearing to that with a nil
// column would reintroduce the "first read of 0,0 stays empty forever" bug
// unless AddChunk refreshes the cache — which it does. Using an unreachable
// sentinel makes the next lookup always refill from the dimension map.
func (w *World) invalidateChunkCache() {
	w.currentChunk = nil
	w.currentChunkPos = world.ChunkPos{math.MaxInt32, math.MaxInt32}
}

// columns returns the column map for the current dimension, creating it if needed.
func (w *World) columns() map[world.ChunkPos]*Column {
	m, ok := w.chunks[w.dimension]
	if !ok {
		m = make(map[world.ChunkPos]*Column)
		w.chunks[w.dimension] = m
	}
	return m
}

// Chunks returns all chunks in the current dimension.
func (w *World) Chunks() iter.Seq2[world.ChunkPos, *chunk.Chunk] {
	return func(yield func(world.ChunkPos, *chunk.Chunk) bool) {
		for pos, ch := range w.chunks[w.dimension] {
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

// EntityByUniqueID looks up an entity by the unique ID RemoveActor carries.
//
// @param uid The entity unique ID.
// @returns the entity and whether it was tracked.
func (w *World) EntityByUniqueID(uid int64) (Entity, bool) {
	ent, ok := w.byUnique[uid]
	return ent, ok
}

// AddEntity ...
func (w *World) AddEntity(ent Entity) {
	w.entities[ent.RuntimeID()] = ent
	w.byUnique[ent.UniqueID()] = ent
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
	delete(w.byUnique, ent.UniqueID())
	if ent.Type() == "minecraft:player" {
		name, ok := ent.(interface{ Name() string })
		if ok {
			delete(w.players, name.Name())
		}
	}
}

// RemoveEntityByUniqueID removes the entity with the given unique ID.
//
// RemoveActor identifies entities by unique ID, which is not always equal to
// the runtime ID the entity map is keyed on — looking up by runtime ID left
// ghosts whenever the two differed.
//
// @param uid The entity unique ID from RemoveActor.
// @returns true if an entity was removed.
func (w *World) RemoveEntityByUniqueID(uid int64) bool {
	ent, ok := w.byUnique[uid]
	if !ok {
		return false
	}
	w.RemoveEntity(ent)
	return true
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
	ch, ok := w.chunks[w.dimension][pos]
	return ch, ok
}

// AddChunk ...
func (w *World) AddChunk(pos world.ChunkPos, c *Column) {
	// Column creation / replacement is a content change for anything caching
	// by Revision — bump even when the pointer is new (starts at 0).
	c.Revision++
	w.columns()[pos] = c
	// The one-entry lookup cache starts out holding chunk 0, 0 with no column, so
	// a world whose first read is in that chunk reads it as empty forever.
	if w.currentChunkPos == pos {
		w.currentChunk = c
	}
}

// RemoveChunk is called when chunk is too far away and don't fit in chunk radius.
func (w *World) RemoveChunk(pos world.ChunkPos) {
	if m, ok := w.chunks[w.dimension]; ok {
		delete(m, pos)
	}
	if w.currentChunkPos == pos {
		w.currentChunk = nil
	}
}

// Block reads a block from the position passed. If the chunk is not yet loaded
// at that position air will bee returned.
func (w *World) Block(pos cube.Pos) world.Block {
	return w.block(pos, 0)
}

// BlockAt reads a block and reports whether the column covering pos is loaded.
//
// Block treats an unloaded column as air so physics keeps working; a renderer
// must tell the two apart, or a chunk boundary becomes an open void.
//
// @param pos The block position.
// @returns the block at pos, and whether the column is loaded and in range.
func (w *World) BlockAt(pos cube.Pos) (world.Block, bool) {
	c := w.chunk(chunkPosFromBlockPos(pos))
	if c == nil || pos.OutOfBounds(c.Range()) {
		return block.Air{}, false
	}
	return w.block(pos, 0), true
}

// Loaded reports whether the column covering pos is present and the position
// falls inside that column's vertical range.
//
// @param pos The block position.
// @returns true when BlockAt would return ok.
func (w *World) Loaded(pos cube.Pos) bool {
	c := w.chunk(chunkPosFromBlockPos(pos))
	return c != nil && !pos.OutOfBounds(c.Range())
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

// DecodeNetworkRuntimeID is the exported form of decodeRuntimeID for snapshot
// encoding. The viewer must name blocks from the same local ID the bot uses
// for physics, while still carrying the raw network rid as an opaque fallback.
//
// @param rid The ID as stored in a chunk or block update.
// @returns the local runtime ID, or the input unchanged when it is already one.
func (w *World) DecodeNetworkRuntimeID(rid uint32) uint32 {
	return w.decodeRuntimeID(rid)
}

// Columns returns every column in the current dimension, including ones whose
// blocks have not yet arrived (requested / partial). The viewer needs State,
// which Chunks() alone does not expose.
func (w *World) Columns() iter.Seq2[world.ChunkPos, *Column] {
	return func(yield func(world.ChunkPos, *Column) bool) {
		for pos, col := range w.chunks[w.dimension] {
			if !yield(pos, col) {
				return
			}
		}
	}
}

// NetworkBlockRuntimeID returns the raw network runtime ID stored at pos.
//
// @param pos The block position.
// @param layer The chunk layer.
// @returns the stored ID and whether the column is loaded and in range.
func (w *World) NetworkBlockRuntimeID(pos cube.Pos, layer uint8) (uint32, bool) {
	c := w.chunk(chunkPosFromBlockPos(pos))
	if c == nil || pos.OutOfBounds(c.Range()) {
		return 0, false
	}
	return c.Block(uint8(pos[0]), int16(pos[1]), uint8(pos[2]), layer), true
}

// chunk returns *chunk.Chunk or nil.
func (w *World) chunk(pos world.ChunkPos) *Column {
	if w.currentChunkPos == pos {
		return w.currentChunk
	}
	ch := w.chunks[w.dimension][pos]
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
