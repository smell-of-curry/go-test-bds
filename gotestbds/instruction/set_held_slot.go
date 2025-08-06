package instruction

import (
	"context"
	"github.com/smell-of-curry/go-test-bds/gotestbds/actor"
	"github.com/smell-of-curry/go-test-bds/gotestbds/bot"
)

// SetHeldSlot ...
type SetHeldSlot struct {
	Slot int `json:"slot"`
}

// Name ...
func (s *SetHeldSlot) Name() string {
	return "setHeldSlot"
}

// Run ...
func (s *SetHeldSlot) Run(_ context.Context, b *bot.Bot) error {
	return execute(b, func(a *actor.Actor) error {
		return a.SetHeldSlot(s.Slot)
	})
}
