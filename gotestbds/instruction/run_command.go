package instruction

import (
	"context"

	"github.com/smell-of-curry/go-test-bds/gotestbds/actor"
	"github.com/smell-of-curry/go-test-bds/gotestbds/bot"
)

// RunCommand runs a server command as the Actor.
type RunCommand struct {
	Command string `json:"command"`
}

// Name is the name of the instruction.
func (*RunCommand) Name() string {
	return "runCommand"
}

// Run is the function that runs the instruction.
func (r *RunCommand) Run(ctx context.Context, b *bot.Bot) error {
	return execute(b, func(a *actor.Actor) error {
		a.RunCommand(r.Command)
		return nil
	})
}
