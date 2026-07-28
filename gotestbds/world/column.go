package world

import (
	"github.com/df-mc/dragonfly/server/block/cube"
	"github.com/df-mc/dragonfly/server/world"
	"github.com/df-mc/dragonfly/server/world/chunk"
)

// ColumnState is how far along a column is in arriving from the server.
type ColumnState uint8

const (
	// ColumnRequested means LevelChunk arrived in a sub-chunk request mode and
	// the bot has asked for the blocks but none have landed yet.
	ColumnRequested ColumnState = iota
	// ColumnPartial means at least one requested sub-chunk has arrived, but not
	// every outstanding one.
	ColumnPartial
	// ColumnComplete means the column's blocks are fully present — either the
	// LevelChunk payload carried them inline, or every requested sub-chunk came
	// back.
	ColumnComplete
)

// String ...
func (s ColumnState) String() string {
	switch s {
	case ColumnRequested:
		return "requested"
	case ColumnPartial:
		return "partial"
	case ColumnComplete:
		return "complete"
	default:
		return "unknown"
	}
}

// Column stores both Chunk & BlockEntities.
type Column struct {
	*chunk.Chunk
	BlockEntities map[cube.Pos]world.Block
	State         ColumnState

	// Revision increments on every mutation of this column's blocks or load
	// state. The world is single-goroutine, so a plain counter is enough —
	// the viewer encoder keys its column cache on this to skip re-encoding.
	Revision uint64

	// pendingSubChunks is how many SubChunk entries this column still expects
	// after a request-mode LevelChunk. Zero once complete or when the payload
	// arrived inline.
	pendingSubChunks int

	// lightDirty means sky/block light needs a Fill before the next snapshot
	// read. Set on completion and on block edits; cleared by EnsureColumnLight.
	lightDirty bool
}

// SetBlock writes a block and bumps Revision so cache consumers notice.
//
// @param x Local X within the column (0–15).
// @param y World Y.
// @param z Local Z within the column (0–15).
// @param layer Chunk layer.
// @param block Network (or local) runtime ID to store.
func (c *Column) SetBlock(x uint8, y int16, z uint8, layer uint8, block uint32) {
	c.Chunk.SetBlock(x, y, z, layer, block)
	c.Revision++
	if c.State == ColumnComplete {
		c.lightDirty = true
	}
}

// NewColumn ...
func NewColumn(c *chunk.Chunk, nbters []chunk.BlockEntity) *Column {
	col := &Column{
		Chunk:         c,
		BlockEntities: make(map[cube.Pos]world.Block, len(nbters)),
		State:         ColumnComplete,
		lightDirty:    true,
	}
	for _, be := range nbters {
		rid := c.Block(uint8(be.Pos[0]), int16(be.Pos[1]), uint8(be.Pos[2]), 0)
		b, ok := world.BlockByRuntimeID(rid)
		if !ok {
			continue
		}
		nb, ok := b.(world.NBTer)
		if !ok {
			continue
		}
		col.BlockEntities[be.Pos] = nb.DecodeNBT(be.Data).(world.Block)
	}
	return col
}

// ExpectSubChunks marks the column as waiting on n SubChunk responses.
//
// SubChunkCount on LevelChunk is a request-mode sentinel for Limited/Limitless
// — the payload then holds biomes, not blocks — so the column starts empty and
// only becomes complete once every requested sub-chunk has arrived.
//
// @param n How many sub-chunks were requested, counted up from the bottom.
func (c *Column) ExpectSubChunks(n int) {
	c.Revision++
	if n <= 0 {
		c.pendingSubChunks = 0
		c.State = ColumnComplete
		c.lightDirty = true
		return
	}
	c.pendingSubChunks = n
	c.State = ColumnRequested
	c.lightDirty = false
}

// ReceiveSubChunk records one requested sub-chunk arriving and promotes the
// column toward complete.
//
// Callers write the decoded sub-chunk into c.Sub() before this; the revision
// bump covers that mutation even when the column was already complete.
func (c *Column) ReceiveSubChunk() {
	c.Revision++
	if c.pendingSubChunks > 0 {
		c.pendingSubChunks--
	}
	if c.pendingSubChunks == 0 {
		c.State = ColumnComplete
		c.lightDirty = true
		return
	}
	c.State = ColumnPartial
}

// PendingSubChunks returns how many requested sub-chunks have not yet arrived.
//
// @returns the outstanding count.
func (c *Column) PendingSubChunks() int {
	return c.pendingSubChunks
}
