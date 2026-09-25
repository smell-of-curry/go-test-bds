package instruction

import (
	"context"
	"fmt"

	"github.com/smell-of-curry/go-test-bds/gotestbds/actor"
	"github.com/smell-of-curry/go-test-bds/gotestbds/bot"
)

// InteractWithEntity right-clicks an entity by runtime ID (mount, use item).
type InteractWithEntity struct {
	EntityRuntimeID uint64 `json:"entityRuntimeID"`
}

// Name is the name of the instruction.
func (*InteractWithEntity) Name() string {
	return "interactWithEntity"
}

// Run is the function that runs the instruction.
func (action *InteractWithEntity) Run(_ context.Context, b *bot.Bot) error {
	return execute(b, func(a *actor.Actor) error {
		ent, ok := a.World().Entity(action.EntityRuntimeID)
		if !ok {
			return fmt.Errorf("entity does not exist")
		}
		return a.UseItemOnEntity(ent)
	})
}
