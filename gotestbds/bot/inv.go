package bot

import (
	"github.com/sandertv/gophertunnel/minecraft/protocol"
	"github.com/sandertv/gophertunnel/minecraft/protocol/packet"
	"github.com/smell-of-curry/go-test-bds/gotestbds/inventory"
)

// invByID returns inventory by it id.
func (b *Bot) invByID(id uint32) *inventory.Handle {
	switch id {
	case protocol.WindowIDInventory:
		return b.a.Inventory()
	case protocol.WindowIDOffHand:
		return b.a.Offhand()
	case protocol.WindowIDArmour:
		return b.a.Armour().Inventory()
	case protocol.WindowIDUI:
		return b.a.UiInv()
	case b.currentContainerID:
		if b.currentContainer != nil {
			return b.currentContainer.Inventory()
		}
	}
	return nil
}

// WriteInventoryAction implement inventory.ActionWriter.
func (b *Bot) WriteInventoryAction(action protocol.StackRequestAction, changes *inventory.History) {
	// decrementing currentRequestID by 2, cause that's how vanilla client does it.
	b.currentRequestID -= 2
	b.pendingItemStackResponses[b.currentRequestID] = changes
	_ = b.conn.WritePacket(&packet.ItemStackRequest{Requests: []protocol.ItemStackRequest{
		{
			RequestID: b.currentRequestID,
			Actions:   []protocol.StackRequestAction{action},
		},
	}})
}
