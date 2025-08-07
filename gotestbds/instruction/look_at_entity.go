package instruction

import (
	"context"
	"fmt"
	"github.com/smell-of-curry/go-test-bds/gotestbds/actor"
	"github.com/smell-of-curry/go-test-bds/gotestbds/bot"
)

// LookAtEntity ...
type LookAtEntity struct {
	RuntimeID uint64 `json:"runtimeID"`
}

// Name ...
func (*LookAtEntity) Name() string {
	return "lookAtEntity"
}

// Run ...
func (l *LookAtEntity) Run(ctx context.Context, b *bot.Bot) error {
	return execute(b, func(a *actor.Actor) error {
		ent, ok := a.World().Entity(l.RuntimeID)
		if !ok {
			return fmt.Errorf("entity not found")
		}
		a.LookAtEntity(ent)
		return nil
	})
}
