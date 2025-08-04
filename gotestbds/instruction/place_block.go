package instruction

import (
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
	return "Place"
}

// Run ...
func (p *PlaceBlock) Run(b *bot.Bot) (succeed bool) {
	ch := make(chan struct{})
	b.Execute(func(actor *actor.Actor) {
		succeed = actor.PlaceBlock(p.Pos)
		close(ch)
	})
	<-ch
	return
}
