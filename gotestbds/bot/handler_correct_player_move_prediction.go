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
// Soft corrects are ignored while Navigate owns the client prediction: live
// showcase (11b3e4a) showed Correct every ~300ms snapping the bot back to the
// pre-walk pose, so MoveRawInput made same-tick progress but never arrived —
// NavigateToBlock hit context deadline with zero fruitless. MovePlayer
// teleports still apply (different packet).
func (*CorrectPlayerMovePredictionHandler) Handle(p packet.Packet, b *Bot, a *actor.Actor) error {
	if a.Navigating() {
		return nil
	}
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
