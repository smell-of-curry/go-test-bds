package instruction

import (
	"context"

	"github.com/smell-of-curry/go-test-bds/gotestbds/actor"
	"github.com/smell-of-curry/go-test-bds/gotestbds/bot"
)

// Attack attacks entity from Actor's view direction.
type Attack struct{}

// Name ...
func (*Attack) Name() string {
	return "attack"
}

// Run ...
func (a *Attack) Run(ctx context.Context, b *bot.Bot) error {
	return execute(b, func(a *actor.Actor) error {
		return a.Attack()
	})
}
