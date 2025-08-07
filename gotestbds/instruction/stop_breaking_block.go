package instruction

import (
	"context"
	"github.com/smell-of-curry/go-test-bds/gotestbds/actor"
	"github.com/smell-of-curry/go-test-bds/gotestbds/bot"
)

// StopBreakingBlock ...
type StopBreakingBlock struct{}

// Name ...
func (*StopBreakingBlock) Name() string {
	return "stopBreakingBlock"
}

// Run ...
func (*StopBreakingBlock) Run(ctx context.Context, b *bot.Bot) error {
	return execute(b, func(a *actor.Actor) error {
		a.AbortBreaking()
		return nil
	})
}
