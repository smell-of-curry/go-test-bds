package instruction

import (
	"context"
	"github.com/smell-of-curry/go-test-bds/gotestbds/actor"
	"github.com/smell-of-curry/go-test-bds/gotestbds/bot"
)

// DropSelectedItem ...
type DropSelectedItem struct{}

// Name ...
func (*DropSelectedItem) Name() string {
	return "dropSelectedItem"
}

// Run ...
func (*DropSelectedItem) Run(ctx context.Context, b *bot.Bot) error {
	return execute(b, func(a *actor.Actor) error {
		return a.Inventory().DropItem(a.HeldSlot(), a.HeldItem().Count())
	})
}
