package bot

import (
	"fmt"

	"github.com/sandertv/gophertunnel/minecraft/protocol/packet"
	"github.com/smell-of-curry/go-test-bds/gotestbds/actor"
	"github.com/smell-of-curry/go-test-bds/gotestbds/mcmath"
)

// SetActorMotionHandler handles SetActorMotion packet.
type SetActorMotionHandler struct{}

// Handle ...
func (*SetActorMotionHandler) Handle(p packet.Packet, b *Bot, a *actor.Actor) error {
	setActorMotion := p.(*packet.SetActorMotion)
	ent, ok := a.World().Entity(setActorMotion.EntityRuntimeID)
	if !ok {
		return fmt.Errorf("unable to find entity with Rid: %d", setActorMotion.EntityRuntimeID)
	}
	ent.SetVelocity(mcmath.Vec32To64(setActorMotion.Velocity))
	return nil
}
