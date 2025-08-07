package instruction

import (
	"context"
	"github.com/smell-of-curry/go-test-bds/gotestbds/actor"
	"github.com/smell-of-curry/go-test-bds/gotestbds/bot"
)

// StopNavigating ...
type StopNavigating struct{}

// Name ...
func (*StopNavigating) Name() string {
	return "stopNavigating"
}

// Run ...
func (*StopNavigating) Run(ctx context.Context, b *bot.Bot) error {
	return execute(b, func(a *actor.Actor) error {
		a.StopNavigating()
		return nil
	})
}
