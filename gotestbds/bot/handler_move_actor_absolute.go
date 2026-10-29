package bot

import (
	"github.com/df-mc/dragonfly/server/block/cube"
	"github.com/sandertv/gophertunnel/minecraft/protocol/packet"
	"github.com/smell-of-curry/go-test-bds/gotestbds/actor"
	"github.com/smell-of-curry/go-test-bds/gotestbds/entity"
	"github.com/smell-of-curry/go-test-bds/gotestbds/mcmath"
)

// MoveActorAbsoluteHandler handles MoveActorAbsolute packet.
type MoveActorAbsoluteHandler struct{}

// Handle ...
func (m MoveActorAbsoluteHandler) Handle(p packet.Packet, b *Bot, a *actor.Actor) error {
	pk := p.(*packet.MoveActorAbsolute)
	ent, ok := a.World().Entity(pk.EntityRuntimeID)
	if !ok {
		return nil
	}
	// Rotation is pitch, body yaw, head yaw (degrees), not a direction.
	ent.Move(entity.FeetOf(ent, mcmath.Vec32To64(pk.Position)), cube.Rotation{float64(pk.Rotation[1]), float64(pk.Rotation[0])})
	setHeadYaw(ent, float64(pk.Rotation[2]))
	return nil
}

// setHeadYaw records the head yaw on entities that track one.
func setHeadYaw(ent any, yaw float64) {
	if h, ok := ent.(interface{ SetHeadYaw(float64) }); ok {
		h.SetHeadYaw(yaw)
	}
}
