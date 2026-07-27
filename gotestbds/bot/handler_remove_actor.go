package bot

import (
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
		// The server removes entities that were never added for this client,
		// e.g. one that despawned outside the bot's chunk radius.
		b.logger.Debug("removing untracked entity", "entity", removeActor.EntityUniqueID)
		return nil
	}
	w.RemoveEntity(ent)
	return nil
}
