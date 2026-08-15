package instruction

import (
	"context"

	"github.com/smell-of-curry/go-test-bds/gotestbds/actor"
	"github.com/smell-of-curry/go-test-bds/gotestbds/bot"
)

// GetState returns the bot's current actor state.
type GetState struct {
	result any
}

// Name returns the instruction name.
func (*GetState) Name() string {
	return "getState"
}

// Run collects the current actor state.
func (g *GetState) Run(ctx context.Context, b *bot.Bot) error {
	return execute(b, func(a *actor.Actor) error {
		pos := a.Position()
		yaw, pitch := a.Rotation().Elem()
		g.result = map[string]any{
			"name":      a.Name(),
			"xuid":      a.XUID(),
			"runtimeId": a.RuntimeID(),
			"position":  Vec3JSON{X: pos.X(), Y: pos.Y(), Z: pos.Z()},
			"rotation":  RotationJSON{Yaw: yaw, Pitch: pitch},
			"health":    a.Health(),
			"maxHealth": a.MaxHealth(),
			"onGround":  a.OnGround(),
			"gameMode":  a.Gamemode(),
			"dimension": a.Dimension(),
			"heldSlot":  a.HeldSlot(),
			"sneaking":  a.Sneaking(),
		}
		return nil
	})
}

// Data returns the state payload from the last successful Run.
func (g *GetState) Data() any {
	return g.result
}
