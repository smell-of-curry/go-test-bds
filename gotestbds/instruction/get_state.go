package instruction

import (
	"context"
	"math"

	"github.com/df-mc/dragonfly/server/world"
	"github.com/smell-of-curry/go-test-bds/gotestbds/actor"
	"github.com/smell-of-curry/go-test-bds/gotestbds/bot"
	gw "github.com/smell-of-curry/go-test-bds/gotestbds/world"
)

// GetState returns the bot's current actor state.
type GetState struct {
	// ChunkRadius bounds the chunk coverage report (default: the server's
	// chunk radius).
	ChunkRadius int `json:"chunkRadius,omitempty"`
	result      any
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
			"name":            a.Name(),
			"xuid":            a.XUID(),
			"runtimeId":       a.RuntimeID(),
			"position":        Vec3JSON{X: pos.X(), Y: pos.Y(), Z: pos.Z()},
			"rotation":        RotationJSON{Yaw: yaw, Pitch: pitch},
			"health":          a.Health(),
			"maxHealth":       a.MaxHealth(),
			"onGround":        a.OnGround(),
			"gameMode":        a.Gamemode(),
			"dimension":       a.Dimension(),
			"heldSlot":        a.HeldSlot(),
			"sneaking":        a.Sneaking(),
			"vehicleUniqueId": a.VehicleUniqueID(),
			"tick":            a.CurrentTick(),
			"chunks":          chunkCoverage(a, g.ChunkRadius),
		}
		return nil
	})
}

// chunkCoverage counts the complete columns the bot holds within radius
// chunks (a circle, as servers send them) of its current position.
func chunkCoverage(a *actor.Actor, radius int) map[string]int {
	if radius <= 0 {
		radius = a.ChunkRadius()
	}
	pos := a.Position()
	cx, cz := int32(math.Floor(pos.X()))>>4, int32(math.Floor(pos.Z()))>>4
	loaded, expected := 0, 0
	for dx := -radius; dx <= radius; dx++ {
		for dz := -radius; dz <= radius; dz++ {
			if dx*dx+dz*dz > radius*radius {
				continue
			}
			expected++
			// A requested column exists but holds no blocks yet; counting it
			// let a shoot roll on void.
			if col, ok := a.World().Chunk(world.ChunkPos{cx + int32(dx), cz + int32(dz)}); ok && col.State == gw.ColumnComplete {
				loaded++
			}
		}
	}
	return map[string]int{"radius": radius, "loaded": loaded, "expected": expected}
}

// Data returns the state payload from the last successful Run.
func (g *GetState) Data() any {
	return g.result
}
