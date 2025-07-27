package bot

import (
	"fmt"
	"github.com/sandertv/gophertunnel/minecraft/protocol/packet"
	"github.com/smell-of-curry/go-test-bds/gotestbds/actor"
	"github.com/smell-of-curry/go-test-bds/gotestbds/internal"
)

// InventorySlotHandler ...
type InventorySlotHandler struct{}

// Handle ...
func (*InventorySlotHandler) Handle(p packet.Packet, b *Bot, a *actor.Actor) {
	inventorySlot := p.(*packet.InventorySlot)

	b.handlingInventories = true
	defer func() {
		b.handlingInventories = false
	}()

	slot := int(inventorySlot.Slot)

	inv := b.invByID(inventorySlot.WindowID)
	if inv == nil {
		b.logger.Error("unable to process InventorySlot packet", "err", fmt.Errorf("unknown windowID %d", inventorySlot.WindowID))
		return
	}

	err := inv.SetItem(slot, internal.StackToItem(inventorySlot.NewItem.Stack), inventorySlot.NewItem.StackNetworkID)
	if err != nil {
		b.logger.Error("unable to process InventorySlot packet", "err", err)
		return
	}
}
