package instruction

import (
	"context"
	"github.com/smell-of-curry/go-test-bds/gotestbds/actor"
	"github.com/smell-of-curry/go-test-bds/gotestbds/bot"
)

// StopUsingItem releases the currently used item.
type StopUsingItem struct{}

// Name is the name of the instruction.
func (*StopUsingItem) Name() string {
	return "stopUsingItem"
}

func (*StopUsingItem) Run(ctx context.Context, b *bot.Bot) error {
	return execute(b, func(a *actor.Actor) error {
		a.ReleaseItem()
		return nil
	})
}
