package bot

import (
	"fmt"
	"github.com/sandertv/gophertunnel/minecraft/protocol/packet"
	"github.com/smell-of-curry/go-test-bds/gotestbds/actor"
)

// InventorySlotHandler ...
type InventorySlotHandler struct{}

// Handle ...
func (*InventorySlotHandler) Handle(p packet.Packet, b *Bot, a *actor.Actor) {
	inventorySlot := p.(*packet.InventorySlot)

	slot := int(inventorySlot.Slot)

	inv := b.invByID(inventorySlot.WindowID)
	if inv == nil {
		b.logger.Error("unable to process InventorySlot packet", "err", fmt.Errorf("unknown windowID %d", inventorySlot.WindowID))
		return
	}

	err := inv.SetItem(slot, inventorySlot.NewItem)
	if err != nil {
		b.logger.Error("unable to process InventorySlot packet", "err", err)
		return
	}
}
