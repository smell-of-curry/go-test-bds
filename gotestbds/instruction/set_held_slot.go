package instruction

import (
	"context"
	"github.com/smell-of-curry/go-test-bds/gotestbds/actor"
	"github.com/smell-of-curry/go-test-bds/gotestbds/bot"
)

// SetHeldSlot sets the currently held hotbar slot.
type SetHeldSlot struct {
	Slot int `json:"slot"`
}

// Name is the name of the instruction.
func (s *SetHeldSlot) Name() string {
	return "setHeldSlot"
}

// Run is the function that runs the instruction.
func (s *SetHeldSlot) Run(_ context.Context, b *bot.Bot) error {
	return execute(b, func(a *actor.Actor) error {
		return a.SetHeldSlot(s.Slot)
	})
}
