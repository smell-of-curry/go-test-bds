package instruction

import (
	"context"

	"github.com/smell-of-curry/go-test-bds/gotestbds/actor"
	"github.com/smell-of-curry/go-test-bds/gotestbds/bot"
)

// Attack attacks entity from Actor's view direction.
type Attack struct{}

// Name is the name of the instruction.
func (*Attack) Name() string {
	return "attack"
}

// Run is the function that runs the instruction.
func (a *Attack) Run(ctx context.Context, b *bot.Bot) error {
	return execute(b, func(a *actor.Actor) error {
		return a.Attack()
	})
}
