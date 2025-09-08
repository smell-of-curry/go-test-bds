package instruction

import (
	"context"
	"fmt"
	"github.com/df-mc/dragonfly/server/block/cube"
	"github.com/smell-of-curry/go-test-bds/gotestbds/actor"
	"github.com/smell-of-curry/go-test-bds/gotestbds/bot"
	"github.com/smell-of-curry/go-test-bds/gotestbds/mcmath/physics/movement"
)

// MoveRawInput moves the Actor using raw input values and delta rotation.
type MoveRawInput struct {
	movement.Input
	DeltaRotation cube.Rotation `json:"deltaRotation"`
}

// Name is the name of the instruction.
func (*MoveRawInput) Name() string {
	return "moveRawInput"
}

// Run is the function that runs the instruction.
func (m *MoveRawInput) Run(ctx context.Context, b *bot.Bot) error {
	return execute(b, func(a *actor.Actor) error {
		if !a.MoveRawInput(m.Input, m.DeltaRotation) {
			return fmt.Errorf("unable to move")
		}
		return nil
	})
}
