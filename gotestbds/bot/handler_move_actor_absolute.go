package bot

import (
	"github.com/df-mc/dragonfly/server/block/cube"
	"github.com/sandertv/gophertunnel/minecraft/protocol/packet"
	"github.com/smell-of-curry/go-test-bds/gotestbds/actor"
	"github.com/smell-of-curry/go-test-bds/gotestbds/mcmath"
)

// MoveActorAbsoluteHandler handles MoveActorAbsolute packet.
type MoveActorAbsoluteHandler struct{}

// Handle ...
func (m MoveActorAbsoluteHandler) Handle(p packet.Packet, b *Bot, a *actor.Actor) error {
	moveActorAbsolute := p.(*packet.MoveActorAbsolute)
	ent, ok := a.World().Entity(moveActorAbsolute.EntityRuntimeID)

	var rot cube.Rotation
	if moveActorAbsolute.Rotation.Y() == moveActorAbsolute.Rotation.Z() {
		rot = cube.Rotation{
			float64(moveActorAbsolute.Rotation.Z()),
			float64(moveActorAbsolute.Rotation.X()),
		}
	} else {
		rot = mcmath.VectorToRotation(mcmath.Vec32To64(moveActorAbsolute.Rotation))
	}

	if ok {
		ent.Move(mcmath.Vec32To64(moveActorAbsolute.Position), rot)
	}
	return nil
}
