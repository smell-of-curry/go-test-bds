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
	// RemoveActor carries the unique ID, which is not always equal to the
	// runtime ID the entity map is keyed on. Looking up by runtime ID left
	// ghosts whenever the two differed.
	if !a.World().RemoveEntityByUniqueID(removeActor.EntityUniqueID) {
		// The server removes entities that were never added for this client,
		// e.g. one that despawned outside the bot's chunk radius.
		b.logger.Debug("removing untracked entity", "entity", removeActor.EntityUniqueID)
	}
	return nil
}
