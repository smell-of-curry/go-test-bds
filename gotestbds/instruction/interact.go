package instruction

import (
	"context"
	"github.com/smell-of-curry/go-test-bds/gotestbds/actor"
	"github.com/smell-of-curry/go-test-bds/gotestbds/bot"
)

// Interact uses the item currently held by the Actor.
type Interact struct{}

// Name is the name of the instruction.
func (*Interact) Name() string {
	return "interact"
}

// Run is the function that runs the instruction.
func (*Interact) Run(ctx context.Context, b *bot.Bot) error {
	return execute(b, func(a *actor.Actor) error {
		a.UseItem()
		return nil
	})
}
