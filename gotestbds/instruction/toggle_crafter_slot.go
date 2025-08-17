package instruction

import (
	"context"

	"github.com/df-mc/dragonfly/server/block/cube"
	"github.com/smell-of-curry/go-test-bds/gotestbds/actor"
	"github.com/smell-of-curry/go-test-bds/gotestbds/bot"
)

// ToggleCrafterSlot toggles crafter slot.
type ToggleCrafterSlot struct {
	Slot     int      `json:"slot"`
	Pos      cube.Pos `json:"pos"`
	Disabled bool     `json:"disabled"`
}

// Name ...
func (*ToggleCrafterSlot) Name() string {
	return "toggleCrafterSlot"
}

// Run ...
func (t *ToggleCrafterSlot) Run(ctx context.Context, b *bot.Bot) error {
	return execute(b, func(a *actor.Actor) error {
		return a.ToggleCrafterSlot(t.Pos, t.Slot, t.Disabled)
	})
}
