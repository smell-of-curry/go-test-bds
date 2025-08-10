package instruction

import (
	"context"

	"github.com/smell-of-curry/go-test-bds/gotestbds/actor"
	"github.com/smell-of-curry/go-test-bds/gotestbds/bot"
)

// RunCommand ...
type RunCommand struct {
	Command string `json:"command"`
}

// Name ...
func (*RunCommand) Name() string {
	return "runCommand"
}

// Run ...
func (r *RunCommand) Run(ctx context.Context, b *bot.Bot) error {
	return execute(b, func(a *actor.Actor) error {
		a.RunCommand(r.Command)
		return nil
	})
}
