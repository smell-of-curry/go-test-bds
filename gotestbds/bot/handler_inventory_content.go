package bot

import (
	"fmt"

	"github.com/sandertv/gophertunnel/minecraft/protocol"
	"github.com/sandertv/gophertunnel/minecraft/protocol/packet"
	"github.com/smell-of-curry/go-test-bds/gotestbds/actor"
	"github.com/smell-of-curry/go-test-bds/gotestbds/inventory"
)

// InventoryContentHandler handles InventoryContent packet, updates Actor's inventory content.
type InventoryContentHandler struct{}

// Handle ...
func (*InventoryContentHandler) Handle(p packet.Packet, b *Bot, a *actor.Actor) error {
	inventoryContent := p.(*packet.InventoryContent)

	inv := b.invByID(inventoryContent.WindowID)
	if inv == nil {
		return fmt.Errorf("unknown windowID: %d", inventoryContent.WindowID)
	}

	return fillInventory(inv, inventoryContent.Content)
}

// fillInventory ...
func fillInventory(inv *inventory.Handle, content []protocol.ItemInstance) error {
	for slot := range inv.Size() {
		slotContent := content[slot]
		err := inv.SetItem(slot, slotContent)
		if err != nil {
			return err
		}
	}
	return nil
}
