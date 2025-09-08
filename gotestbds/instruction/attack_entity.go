package instruction

import (
	"context"
	"fmt"

	"github.com/smell-of-curry/go-test-bds/gotestbds/actor"
	"github.com/smell-of-curry/go-test-bds/gotestbds/bot"
)

// AttackEntity is an instruction to attack an entity.
type AttackEntity struct {
	EntityRuntimeID uint64 `json:"entityRuntimeID"`
}

// Name is the name of the instruction.
func (*AttackEntity) Name() string {
	return "attackEntity"
}

// Run is the function that runs the instruction.
func (action *AttackEntity) Run(_ context.Context, b *bot.Bot) error {
	return execute(b, func(a *actor.Actor) error {
		ent, ok := a.World().Entity(action.EntityRuntimeID)
		if !ok {
			return fmt.Errorf("entity does not exist")
		}
		return a.AttackEntity(ent)
	})
}
