package bot

import (
	"fmt"

	"github.com/sandertv/gophertunnel/minecraft/protocol/packet"
	"github.com/smell-of-curry/go-test-bds/gotestbds/actor"
)

// SetActorDataHandler handlers SetActorData packet.
type SetActorDataHandler struct{}

// Handle ...
func (*SetActorDataHandler) Handle(p packet.Packet, b *Bot, a *actor.Actor) error {
	setActorData := p.(*packet.SetActorData)
	ent, ok := a.World().Entity(setActorData.EntityRuntimeID)
	if !ok {
		return fmt.Errorf("unable to find entity with Rid: %d", setActorData.EntityRuntimeID)
	}
	ent.State().Decode(setActorData.EntityMetadata)
	return nil
}
