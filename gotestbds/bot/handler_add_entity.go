package bot

import (
	"github.com/sandertv/gophertunnel/minecraft/protocol/packet"
	"github.com/smell-of-curry/go-test-bds/gotestbds/actor"
	"github.com/smell-of-curry/go-test-bds/gotestbds/entity"
)

// AddEntityHandler adds new entity to the Actor's world.
type AddEntityHandler struct{}

// Handle ...
func (*AddEntityHandler) Handle(p packet.Packet, b *Bot, a *actor.Actor) error {
	ent := entity.CreateFromPacket(p)
	a.World().AddEntity(ent)
	return nil
}
