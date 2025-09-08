package instruction

import (
	"context"
	"github.com/smell-of-curry/go-test-bds/gotestbds/actor"
	"github.com/smell-of-curry/go-test-bds/gotestbds/bot"
)

// Respawn respawns the Actor at its spawn point.
type Respawn struct {
}

// Name is the name of the instruction.
func (*Respawn) Name() string {
	return "respawn"
}

// Run is the function that runs the instruction.
func (*Respawn) Run(ctx context.Context, b *bot.Bot) error {
	return execute(b, func(a *actor.Actor) error {
		a.Respawn()
		return nil
	})
}
