package instruction

import (
	"context"
	"github.com/smell-of-curry/go-test-bds/gotestbds/actor"
	"github.com/smell-of-curry/go-test-bds/gotestbds/bot"
)

// Interact ...
type Interact struct{}

// Name ...
func (*Interact) Name() string {
	return "interact"
}

// Run ...
func (*Interact) Run(ctx context.Context, b *bot.Bot) error {
	return execute(b, func(a *actor.Actor) error {
		a.UseItem()
		return nil
	})
}
