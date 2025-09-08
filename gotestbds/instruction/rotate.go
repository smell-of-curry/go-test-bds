package instruction

import (
	"context"
	"github.com/df-mc/dragonfly/server/block/cube"
	"github.com/smell-of-curry/go-test-bds/gotestbds/actor"
	"github.com/smell-of-curry/go-test-bds/gotestbds/bot"
)

// Rotate rotates the Actor to the given rotation.
type Rotate struct {
	Rotation cube.Rotation `json:"rotation"`
}

// Name is the name of the instruction.
func (*Rotate) Name() string {
	return "rotate"
}

// Run is the function that runs the instruction.
func (r *Rotate) Run(ctx context.Context, b *bot.Bot) error {
	return execute(b, func(a *actor.Actor) error {
		a.Move(a.Position(), r.Rotation)
		return nil
	})
}
