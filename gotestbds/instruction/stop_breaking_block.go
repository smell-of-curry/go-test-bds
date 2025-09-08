package instruction

import (
	"context"
	"github.com/smell-of-curry/go-test-bds/gotestbds/actor"
	"github.com/smell-of-curry/go-test-bds/gotestbds/bot"
)

// StopBreakingBlock aborts the current block breaking action.
type StopBreakingBlock struct{}

// Name is the name of the instruction.
func (*StopBreakingBlock) Name() string {
	return "stopBreakingBlock"
}

// Run is the function that runs the instruction.
func (*StopBreakingBlock) Run(ctx context.Context, b *bot.Bot) error {
	return execute(b, func(a *actor.Actor) error {
		a.AbortBreaking()
		return nil
	})
}
