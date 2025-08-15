package bot

import (
	"fmt"

	"github.com/sandertv/gophertunnel/minecraft/protocol/packet"
	"github.com/smell-of-curry/go-test-bds/gotestbds/actor"
)

// InventorySlotHandler ...
type InventorySlotHandler struct{}

// Handle ...
func (*InventorySlotHandler) Handle(p packet.Packet, b *Bot, a *actor.Actor) error {
	inventorySlot := p.(*packet.InventorySlot)

	slot := int(inventorySlot.Slot)

	inv := b.invByID(inventorySlot.WindowID)
	if inv == nil {
		return fmt.Errorf("unknown windowID %d", inventorySlot.WindowID)
	}

	return inv.SetItem(slot, inventorySlot.NewItem)
}
