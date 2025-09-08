package instruction

import (
	"context"
	"github.com/smell-of-curry/go-test-bds/gotestbds/actor"
	"github.com/smell-of-curry/go-test-bds/gotestbds/bot"
)

// Jump makes the Actor jump.
type Jump struct{}

// Name is the name of the instruction.
func (*Jump) Name() string {
	return "jump"
}

// Run is the function that runs the instruction.
func (*Jump) Run(ctx context.Context, b *bot.Bot) error {
	return execute(b, func(a *actor.Actor) error {
		a.Jump()
		return nil
	})
}
