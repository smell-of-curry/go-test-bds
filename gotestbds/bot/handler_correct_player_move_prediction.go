package bot

import (
	"github.com/df-mc/dragonfly/server/block/cube"
	"github.com/sandertv/gophertunnel/minecraft/protocol/packet"
	"github.com/smell-of-curry/go-test-bds/gotestbds/actor"
	"github.com/smell-of-curry/go-test-bds/gotestbds/mcmath"
)

// CorrectPlayerMovePredictionHandler handles CorrectPlayerMovePrediction packet.
type CorrectPlayerMovePredictionHandler struct{}

// Handle ...
func (*CorrectPlayerMovePredictionHandler) Handle(p packet.Packet, b *Bot, a *actor.Actor) {
	// this is not correct logic.
	b.logger.Warn("mismatched movement")
	correct := p.(*packet.CorrectPlayerMovePrediction)
	pos := mcmath.Vec32To64(correct.Position)
	rot := cube.Rotation{float64(correct.Rotation[0]), float64(correct.Rotation[1])}
	a.Move(pos, rot)
}
