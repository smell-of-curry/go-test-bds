package instruction

import (
	"context"

	"github.com/smell-of-curry/go-test-bds/gotestbds/actor"
	"github.com/smell-of-curry/go-test-bds/gotestbds/bot"
)

// Instruction is a command that can be executed against a Bot/Actor.
type Instruction interface {
	// Name returns name of the instruction to identify instruction in the pull.
	Name() string
	// Run runs instruction on the Bot.
	Run(ctx context.Context, b *bot.Bot) error
}

// DataInstruction is an Instruction that returns a payload to the caller in the
// status message's "data" field.
type DataInstruction interface {
	Instruction
	// Data returns the payload produced by the last Run. It is only read after
	// Run returns without error.
	Data() any
}

// execute runs a function with the underlying Actor on the Bot's main goroutine.
func execute(b *bot.Bot, fn func(a *actor.Actor) error) error {
	var err error
	<-b.Execute(func(a *actor.Actor) {
		err = fn(a)
	})
	return err
}
