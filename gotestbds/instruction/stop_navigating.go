package instruction

import (
	"context"
	"github.com/smell-of-curry/go-test-bds/gotestbds/actor"
	"github.com/smell-of-curry/go-test-bds/gotestbds/bot"
)

// StopNavigating stops the current navigation.
type StopNavigating struct{}

// Name is the name of the instruction.
func (*StopNavigating) Name() string {
	return "stopNavigating"
}

// Run is the function that runs the instruction.
func (*StopNavigating) Run(ctx context.Context, b *bot.Bot) error {
	return execute(b, func(a *actor.Actor) error {
		a.StopNavigating()
		return nil
	})
}
