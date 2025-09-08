package instruction

import (
	"context"
	"github.com/smell-of-curry/go-test-bds/gotestbds/actor"
	"github.com/smell-of-curry/go-test-bds/gotestbds/bot"
)

// DropSelectedItem drops the currently held item stack.
type DropSelectedItem struct{}

// Name is the name of the instruction.
func (*DropSelectedItem) Name() string {
	return "dropSelectedItem"
}

// Run is the function that runs the instruction.
func (*DropSelectedItem) Run(ctx context.Context, b *bot.Bot) error {
	return execute(b, func(a *actor.Actor) error {
		return a.Inventory().DropItem(a.HeldSlot(), a.HeldItem().Count())
	})
}
