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

	// pendingSubChunks is how many SubChunk entries this column still expects
	// after a request-mode LevelChunk. Zero once complete or when the payload
	// arrived inline.
	pendingSubChunks int
}

// NewColumn ...
func NewColumn(c *chunk.Chunk, nbters []chunk.BlockEntity) *Column {
	col := &Column{Chunk: c, BlockEntities: make(map[cube.Pos]world.Block, len(nbters)), State: ColumnComplete}
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
	if n <= 0 {
		c.pendingSubChunks = 0
		c.State = ColumnComplete
		return
	}
	c.pendingSubChunks = n
	c.State = ColumnRequested
}

// ReceiveSubChunk records one requested sub-chunk arriving and promotes the
// column toward complete.
func (c *Column) ReceiveSubChunk() {
	if c.pendingSubChunks > 0 {
		c.pendingSubChunks--
	}
	if c.pendingSubChunks == 0 {
		c.State = ColumnComplete
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
