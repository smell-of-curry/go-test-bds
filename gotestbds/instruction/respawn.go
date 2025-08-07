package instruction

import (
	"context"
	"github.com/smell-of-curry/go-test-bds/gotestbds/actor"
	"github.com/smell-of-curry/go-test-bds/gotestbds/bot"
)

// Respawn ...
type Respawn struct {
}

// Name ...
func (*Respawn) Name() string {
	return "respawn"
}

// Run ...
func (*Respawn) Run(ctx context.Context, b *bot.Bot) error {
	return execute(b, func(a *actor.Actor) error {
		a.Respawn()
		return nil
	})
}
