package instruction

import (
	"context"
	"github.com/smell-of-curry/go-test-bds/gotestbds/actor"
	"github.com/smell-of-curry/go-test-bds/gotestbds/bot"
)

// Instruction ...
type Instruction interface {
	// Name returns name of the instruction to identify instruction in the pull.
	Name() string
	// Run runs instruction on the Bot.
	Run(ctx context.Context, b *bot.Bot) error
}

// execute ...
func execute(b *bot.Bot, fn func(a *actor.Actor) error) error {
	var err error
	<-b.Execute(func(a *actor.Actor) {
		err = fn(a)
	})
	return err
}
