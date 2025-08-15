package bot

import (
	"fmt"

	"github.com/sandertv/gophertunnel/minecraft/protocol/packet"
	"github.com/smell-of-curry/go-test-bds/gotestbds/actor"
)

// RemoveActorHandler removes actors from the world.
type RemoveActorHandler struct{}

// Handle ...
func (r RemoveActorHandler) Handle(p packet.Packet, b *Bot, a *actor.Actor) error {
	removeActor := p.(*packet.RemoveActor)
	w := a.World()
	ent, ok := w.Entity(uint64(removeActor.EntityUniqueID))
	if !ok {
		return fmt.Errorf("unable to find entity with Rid: %d", removeActor.EntityUniqueID)
	}
	w.RemoveEntity(ent)
	return nil
}
