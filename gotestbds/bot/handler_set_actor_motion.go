package bot

import (
	"github.com/sandertv/gophertunnel/minecraft/protocol/packet"
	"github.com/smell-of-curry/go-test-bds/gotestbds/actor"
	"github.com/smell-of-curry/go-test-bds/gotestbds/mcmath"
)

// SetActorMotionHandler handles SetActorMotion packet.
type SetActorMotionHandler struct{}

// Handle ...
func (*SetActorMotionHandler) Handle(p packet.Packet, b *Bot, a *actor.Actor) {
	setActorMotion := p.(*packet.SetActorMotion)
	ent, ok := a.World().Entity(setActorMotion.EntityRuntimeID)
	if ok {
		ent.SetVelocity(mcmath.Vec32To64(setActorMotion.Velocity))
	}
}
