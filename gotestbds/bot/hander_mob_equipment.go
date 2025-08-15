package bot

import (
	"fmt"

	"github.com/sandertv/gophertunnel/minecraft/protocol"
	"github.com/sandertv/gophertunnel/minecraft/protocol/packet"
	"github.com/smell-of-curry/go-test-bds/gotestbds/actor"
	"github.com/smell-of-curry/go-test-bds/gotestbds/internal"
)

// MobEquipmentHandler ...
type MobEquipmentHandler struct{}

// Handle ...
func (*MobEquipmentHandler) Handle(p packet.Packet, b *Bot, a *actor.Actor) error {
	equipment := p.(*packet.MobEquipment)
	if a.RuntimeID() == equipment.EntityRuntimeID {
		inv := b.invByID(uint32(equipment.WindowID))
		if inv == nil {
			return fmt.Errorf("unknown windowID: %d", equipment.WindowID)
		}
		return nil
	}

	ent, ok := a.World().Entity(equipment.EntityRuntimeID)
	if !ok {
		return fmt.Errorf("unable to find entity with Rid: %d", equipment.EntityRuntimeID)
	}

	main, off := ent.HeldItems()
	switch equipment.WindowID {
	case protocol.WindowIDOffHand:
		return ent.SetHeldItems(main, internal.StackToItem(equipment.NewItem.Stack))
	case protocol.WindowIDInventory:
		return ent.SetHeldItems(internal.StackToItem(equipment.NewItem.Stack), off)
	}
	return nil
}
