package bot

import (
	"fmt"

	"github.com/sandertv/gophertunnel/minecraft/protocol/packet"
	"github.com/smell-of-curry/go-test-bds/gotestbds/actor"
)

// MobArmourEquipmentHandler ...
type MobArmourEquipmentHandler struct{}

// Handle ...
func (m *MobArmourEquipmentHandler) Handle(p packet.Packet, b *Bot, a *actor.Actor) error {
	equipment := p.(*packet.MobArmourEquipment)
	ent, ok := a.World().Entity(equipment.EntityRuntimeID)
	if !ok {
		return fmt.Errorf("unable to find entity with Rid: %d", equipment.EntityRuntimeID)
	}
	inv := ent.Armour().Inventory()
	_ = inv.SetItem(0, equipment.Helmet)
	_ = inv.SetItem(1, equipment.Body)
	_ = inv.SetItem(2, equipment.Leggings)
	_ = inv.SetItem(3, equipment.Boots)
	return nil
}
