package instruction

import (
	"context"
	"fmt"
	"github.com/df-mc/dragonfly/server/block/cube"
	"github.com/smell-of-curry/go-test-bds/gotestbds/actor"
	"github.com/smell-of-curry/go-test-bds/gotestbds/bot"
	"github.com/smell-of-curry/go-test-bds/gotestbds/mcmath/physics/movement"
)

// MoveRawInput ...
type MoveRawInput struct {
	movement.Input
	DeltaRotation cube.Rotation `json:"deltaRotation"`
}

// Name ...
func (*MoveRawInput) Name() string {
	return "moveRawInput"
}

// Run ...
func (m *MoveRawInput) Run(ctx context.Context, b *bot.Bot) error {
	return execute(b, func(a *actor.Actor) error {
		if !a.MoveRawInput(m.Input, m.DeltaRotation) {
			return fmt.Errorf("unable to move")
		}
		return nil
	})
}
