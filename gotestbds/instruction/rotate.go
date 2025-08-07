package instruction

import (
	"context"
	"github.com/df-mc/dragonfly/server/block/cube"
	"github.com/smell-of-curry/go-test-bds/gotestbds/actor"
	"github.com/smell-of-curry/go-test-bds/gotestbds/bot"
)

// Rotate ...
type Rotate struct {
	Rotation cube.Rotation `json:"rotation"`
}

// Name ...
func (*Rotate) Name() string {
	return "rotate"
}

// Run ...
func (r *Rotate) Run(ctx context.Context, b *bot.Bot) error {
	return execute(b, func(a *actor.Actor) error {
		a.Move(a.Position(), r.Rotation)
		return nil
	})
}
