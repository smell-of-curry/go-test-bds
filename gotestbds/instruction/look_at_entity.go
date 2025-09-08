package instruction

import (
	"context"
	"fmt"
	"github.com/smell-of-curry/go-test-bds/gotestbds/actor"
	"github.com/smell-of-curry/go-test-bds/gotestbds/bot"
)

// LookAtEntity turns the Actor to look at an entity by runtime ID.
type LookAtEntity struct {
	RuntimeID uint64 `json:"runtimeID"`
}

// Name is the name of the instruction.
func (*LookAtEntity) Name() string {
	return "lookAtEntity"
}

// Run is the function that runs the instruction.
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
