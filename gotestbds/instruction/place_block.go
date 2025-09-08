package instruction

import (
	"context"

	"github.com/df-mc/dragonfly/server/block/cube"
	"github.com/smell-of-curry/go-test-bds/gotestbds/actor"
	"github.com/smell-of-curry/go-test-bds/gotestbds/bot"
)

// PlaceBlock places the held block at the given position.
type PlaceBlock struct {
	Pos Pos `json:"pos"`
}

// Name is the name of the instruction.
func (p *PlaceBlock) Name() string {
	return "placeBlock"
}

// Run is the function that runs the instruction.
func (p *PlaceBlock) Run(_ context.Context, b *bot.Bot) error {
	return execute(b, func(a *actor.Actor) error {
		return a.PlaceBlock(cube.Pos(p.Pos))
	})
}
