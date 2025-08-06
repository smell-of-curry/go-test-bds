package instruction

import (
	"context"
	"github.com/df-mc/dragonfly/server/block/cube"
	"github.com/smell-of-curry/go-test-bds/gotestbds/actor"
	"github.com/smell-of-curry/go-test-bds/gotestbds/bot"
)

// PlaceBlock ...
type PlaceBlock struct {
	Pos cube.Pos `json:"pos"`
}

// Name ...
func (p *PlaceBlock) Name() string {
	return "placeBlock"
}

// Run ...
func (p *PlaceBlock) Run(_ context.Context, b *bot.Bot) error {
	return execute(b, func(a *actor.Actor) error {
		return a.PlaceBlock(p.Pos)
	})
}
