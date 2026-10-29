package bot

import (
	"github.com/df-mc/dragonfly/server/block/cube"
	"github.com/sandertv/gophertunnel/minecraft/protocol"
	"github.com/sandertv/gophertunnel/minecraft/protocol/packet"
	"github.com/smell-of-curry/go-test-bds/gotestbds/actor"
	"github.com/smell-of-curry/go-test-bds/gotestbds/entity"
	"github.com/smell-of-curry/go-test-bds/gotestbds/world"
)

// AddEntityHandler adds new entity to the Actor's world.
type AddEntityHandler struct{}

// Handle ...
func (*AddEntityHandler) Handle(p packet.Packet, b *Bot, a *actor.Actor) error {
	ent := entity.CreateFromPacket(p)
	var rot cube.Rotation
	switch pk := p.(type) {
	case *packet.AddActor:
		rot = cube.Rotation{float64(pk.Yaw), float64(pk.Pitch)}
		setHeadYaw(ent, float64(pk.HeadYaw))
		setProperties(ent, pk.EntityProperties)
	case *packet.AddPlayer:
		rot = cube.Rotation{float64(pk.Yaw), float64(pk.Pitch)}
		setHeadYaw(ent, float64(pk.HeadYaw))
		setProperties(ent, pk.EntityProperties)
	}
	ent.Move(entity.FeetOf(ent, ent.Position()), rot)
	a.World().AddEntity(ent)
	return nil
}

func setProperties(ent world.Entity, p protocol.EntityProperties) {
	if e, ok := ent.(interface{ SetProperties(protocol.EntityProperties) }); ok {
		e.SetProperties(p)
	}
}
