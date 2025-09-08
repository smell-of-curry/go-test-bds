package instruction

import (
	"context"

	"github.com/df-mc/dragonfly/server/block/cube"
	"github.com/smell-of-curry/go-test-bds/gotestbds/actor"
	"github.com/smell-of-curry/go-test-bds/gotestbds/bot"
)

// LookAtBlock turns the Actor to look at a block position.
type LookAtBlock struct {
	Pos Pos `json:"pos"`
}

// Name is the name of the instruction.
func (*LookAtBlock) Name() string {
	return "lookAtBlock"
}

// Run is the function that runs the instruction.
func (l *LookAtBlock) Run(ctx context.Context, b *bot.Bot) error {
	return execute(b, func(a *actor.Actor) error {
		a.LookAtBlock(cube.Pos(l.Pos))
		return nil
	})
}
