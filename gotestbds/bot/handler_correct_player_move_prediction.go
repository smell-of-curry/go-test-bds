package bot

import (
	"log/slog"

	"github.com/df-mc/dragonfly/server/block/cube"
	"github.com/go-gl/mathgl/mgl64"
	"github.com/sandertv/gophertunnel/minecraft/protocol/packet"
	"github.com/smell-of-curry/go-test-bds/gotestbds/actor"
	"github.com/smell-of-curry/go-test-bds/gotestbds/mcmath"
)

// CorrectPlayerMovePredictionHandler handles CorrectPlayerMovePrediction packet.
type CorrectPlayerMovePredictionHandler struct{}

// Handle applies a server movement correction using the same eye-offset
// convention as PlayerAuthInput / MovePlayer.
//
// The old handler treated the wire position as feet. Auth input sends eyes
// (feet + 1.62); applying that as feet jammed the AABB into ceilings so every
// MoveRawInput collided to zero displacement → fruitless_stuck with a valid path.
func (*CorrectPlayerMovePredictionHandler) Handle(p packet.Packet, b *Bot, a *actor.Actor) error {
	if b != nil && b.logger != nil {
		b.logger.Warn("mismatched movement", slog.String("src", "CorrectPlayerMovePrediction"))
	}
	correct := p.(*packet.CorrectPlayerMovePrediction)
	pos := mcmath.Vec32To64(correct.Position)
	rot := cube.Rotation{float64(correct.Rotation[0]), float64(correct.Rotation[1])}
	feet := pos.Sub(mgl64.Vec3{0, eyeOffset})
	a.Move(feet, rot)
	a.SetVelocity(mgl64.Vec3{})
	a.SetChunkLoadCenter(cube.PosFromVec3(feet))
	return nil
}
