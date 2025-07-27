package bot

import (
	"fmt"
	"github.com/sandertv/gophertunnel/minecraft/protocol"
	"github.com/sandertv/gophertunnel/minecraft/protocol/packet"
	"github.com/smell-of-curry/go-test-bds/gotestbds/actor"
	"github.com/smell-of-curry/go-test-bds/gotestbds/internal"
	"github.com/smell-of-curry/go-test-bds/gotestbds/inventory"
)

// InventoryContentHandler handles InventoryContent packet, updates Actor's inventory content.
type InventoryContentHandler struct{}

// Handle ...
func (*InventoryContentHandler) Handle(p packet.Packet, b *Bot, a *actor.Actor) {
	inventoryContent := p.(*packet.InventoryContent)

	b.handlingInventories = true
	defer func() {
		b.handlingInventories = false
	}()

	inv := b.invByID(inventoryContent.WindowID)
	if inv == nil {
		b.logger.Error("unable to process InventoryContent packet", "err", fmt.Errorf("unknown windowID: %d", inventoryContent.WindowID))
		return
	}

	err := fillInventory(inv, inventoryContent.Content)
	if err != nil {
		b.logger.Error("unable to process InventoryContent packet", "err", err)
	}
}

// fillInventory ...
func fillInventory(inv *inventory.Handle, content []protocol.ItemInstance) error {
	for slot := range inv.Size() {
		slotContent := content[slot]
		err := inv.SetItem(slot, internal.StackToItem(slotContent.Stack), slotContent.StackNetworkID)
		if err != nil {
			return err
		}
	}
	return nil
}
