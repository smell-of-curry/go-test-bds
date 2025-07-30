package bot

import (
	"github.com/sandertv/gophertunnel/minecraft/protocol/packet"
	"github.com/smell-of-curry/go-test-bds/gotestbds/actor"
)

// UpdateAttributesHandler updates attributes for the entity.
type UpdateAttributesHandler struct{}

// Handle ...
func (*UpdateAttributesHandler) Handle(p packet.Packet, b *Bot, a *actor.Actor) {
	updateAttributes := p.(*packet.UpdateAttributes)
	ent, ok := a.World().Entity(updateAttributes.EntityRuntimeID)
	if ok {
		ent.Attributes().Decode(updateAttributes.Attributes)
	}
}
