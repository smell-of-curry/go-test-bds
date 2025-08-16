package world

import (
	"github.com/df-mc/dragonfly/server/block/cube"
	"github.com/df-mc/dragonfly/server/world"
	"github.com/df-mc/dragonfly/server/world/chunk"
)

// Column stores both Chunk & BlockEntities.
type Column struct {
	*chunk.Chunk
	BlockEntities map[cube.Pos]world.Block
}

// NewColumn ...
func NewColumn(c *chunk.Chunk, nbters []chunk.BlockEntity) *Column {
	col := &Column{Chunk: c}
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
