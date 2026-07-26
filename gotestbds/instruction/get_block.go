package instruction

import (
	"context"
	"fmt"

	"github.com/df-mc/dragonfly/server/block/cube"
	dfworld "github.com/df-mc/dragonfly/server/world"
	"github.com/smell-of-curry/go-test-bds/gotestbds/actor"
	"github.com/smell-of-curry/go-test-bds/gotestbds/bot"
)

// GetBlock returns a block at a position from the bot's tracked world.
type GetBlock struct {
	Pos    Pos `json:"pos"`
	result any
}

// Name returns the instruction name.
func (*GetBlock) Name() string {
	return "getBlock"
}

// Run resolves the block at Pos, or errors when the chunk is not loaded.
func (g *GetBlock) Run(ctx context.Context, b *bot.Bot) error {
	return execute(b, func(a *actor.Actor) error {
		pos := cube.Pos(g.Pos)
		chunkPos := dfworld.ChunkPos{int32(pos[0] >> 4), int32(pos[2] >> 4)}
		if _, ok := a.World().Chunk(chunkPos); !ok {
			return fmt.Errorf("chunk not loaded at block %v (chunk %v)", pos, chunkPos)
		}
		name, properties := a.World().Block(pos).EncodeBlock()
		if properties == nil {
			properties = map[string]any{}
		}
		g.result = map[string]any{
			"name":       name,
			"properties": properties,
		}
		return nil
	})
}

// Data returns the block payload from the last successful Run.
func (g *GetBlock) Data() any {
	return g.result
}
