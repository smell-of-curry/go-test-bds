package instruction

import (
	"context"
	"fmt"
	"github.com/smell-of-curry/go-test-bds/gotestbds/actor"
	"github.com/smell-of-curry/go-test-bds/gotestbds/bot"
)

// AttackEntity ...
type AttackEntity struct {
	EntityRuntimeID uint64 `json:"entityRuntimeID"`
}

// Name ...
func (*AttackEntity) Name() string {
	return "attackEntity"
}

// Run ...
func (action *AttackEntity) Run(_ context.Context, b *bot.Bot) error {
	return execute(b, func(a *actor.Actor) error {
		ent, ok := a.World().Entity(action.EntityRuntimeID)
		if !ok {
			return fmt.Errorf("entity does not exist")
		}
		if !a.AttackEntity(ent) {
			return fmt.Errorf("failed to attack entity")
		}
		return nil
	})
}
