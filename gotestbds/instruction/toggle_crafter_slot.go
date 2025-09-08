package instruction

import (
	"context"

	"github.com/df-mc/dragonfly/server/block/cube"
	"github.com/smell-of-curry/go-test-bds/gotestbds/actor"
	"github.com/smell-of-curry/go-test-bds/gotestbds/bot"
)

// ToggleCrafterSlot toggles crafter slot.
type ToggleCrafterSlot struct {
	Slot     int  `json:"slot"`
	Pos      Pos  `json:"pos"`
	Disabled bool `json:"disabled"`
}

// Name is the name of the instruction.
func (*ToggleCrafterSlot) Name() string {
	return "toggleCrafterSlot"
}

// Run is the function that runs the instruction.
func (t *ToggleCrafterSlot) Run(ctx context.Context, b *bot.Bot) error {
	return execute(b, func(a *actor.Actor) error {
		return a.ToggleCrafterSlot(cube.Pos(t.Pos), t.Slot, t.Disabled)
	})
}
