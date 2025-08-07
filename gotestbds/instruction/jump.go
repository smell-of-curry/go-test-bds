package instruction

import (
	"context"
	"github.com/smell-of-curry/go-test-bds/gotestbds/actor"
	"github.com/smell-of-curry/go-test-bds/gotestbds/bot"
)

// Jump ...
type Jump struct{}

// Name ...
func (*Jump) Name() string {
	return "jump"
}

// Run ...
func (*Jump) Run(ctx context.Context, b *bot.Bot) error {
	return execute(b, func(a *actor.Actor) error {
		a.Jump()
		return nil
	})
}
