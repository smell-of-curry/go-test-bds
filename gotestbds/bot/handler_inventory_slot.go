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

	mapping, ok := b.inventoryMappingByID(inventorySlot.WindowID)
	if !ok {
		b.logger.Error("unable to process InventorySlot packet", "err", fmt.Errorf("unknown windowID: %d", inventorySlot.WindowID))
		return
	}

	inv := mapping.inv
	stack := internal.StackToItem(inventorySlot.NewItem.Stack)
	err := inv.SetItem(slot, stack)
	if err != nil {
		b.logger.Error("unable to process InventorySlot packet", "err", err)
		return
	}
	// synchronizing network id's.
	mapping.stackIds[slot] = inventorySlot.NewItem.StackNetworkID
}
