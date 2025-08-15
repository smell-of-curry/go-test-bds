package bot

import (
	"fmt"

	"github.com/sandertv/gophertunnel/minecraft/protocol/packet"
	"github.com/smell-of-curry/go-test-bds/gotestbds/actor"
)

// UpdateAttributesHandler updates attributes for the entity.
type UpdateAttributesHandler struct{}

// Handle ...
func (*UpdateAttributesHandler) Handle(p packet.Packet, b *Bot, a *actor.Actor) error {
	updateAttributes := p.(*packet.UpdateAttributes)
	ent, ok := a.World().Entity(updateAttributes.EntityRuntimeID)
	if !ok {
		return fmt.Errorf("unable to find entity with Rid: %d", updateAttributes.EntityRuntimeID)
	}
	ent.Attributes().Decode(updateAttributes.Attributes)
	return nil
}
