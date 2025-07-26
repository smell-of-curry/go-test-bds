package bot

import (
	"github.com/df-mc/dragonfly/server/item"
	"github.com/df-mc/dragonfly/server/item/inventory"
	"github.com/sandertv/gophertunnel/minecraft/protocol"
	"github.com/sandertv/gophertunnel/minecraft/protocol/packet"
)

// inventoryMapping maps stackID to slot & inventory to windowID.
type inventoryMapping struct {
	windowID uint32
	stackIds []int32
	inv      *inventory.Inventory
}

// newInventoryMapping ...
func newInventoryMapping(windowID uint32, inv *inventory.Inventory) *inventoryMapping {
	return &inventoryMapping{windowID: windowID, stackIds: make([]int32, inv.Size()), inv: inv}
}

// slotInfo ...
func (i *inventoryMapping) slotInfo(slot int) protocol.StackRequestSlotInfo {
	return protocol.StackRequestSlotInfo{
		Container:      protocol.FullContainerName{ContainerID: byte(i.windowID)},
		Slot:           byte(slot),
		StackNetworkID: i.stackIds[slot],
	}
}

// registerInventoryMappings ...
func (b *Bot) registerInventoryMappings() {
	inv := b.a.Inventory()
	ui := b.ui
	offhand := b.a.Offhand()
	armor := b.a.Armor().Inventory()

	b.inventoryMappings = map[*inventory.Inventory]*inventoryMapping{
		inv:     newInventoryMapping(protocol.WindowIDInventory, inv),
		offhand: newInventoryMapping(protocol.WindowIDOffHand, offhand),
		armor:   newInventoryMapping(protocol.WindowIDArmour, armor),
		ui:      newInventoryMapping(protocol.WindowIDUI, ui),
	}
}

// inventoryMapping returns inventoryMapping by id.
func (b *Bot) inventoryMappingByID(id uint32) (*inventoryMapping, bool) {
	mapping, ok := b.inventoryMappings[b.invByID(id)]
	return mapping, ok
}

// inventoryMapping ...
func (b *Bot) inventoryMapping(inv *inventory.Inventory) (*inventoryMapping, bool) {
	mapping, ok := b.inventoryMappings[inv]
	return mapping, ok
}

// invByID ...
func (b *Bot) invByID(id uint32) *inventory.Inventory {
	switch id {
	case protocol.WindowIDInventory:
		return b.a.Inventory()
	case protocol.WindowIDOffHand:
		return b.a.Offhand()
	case protocol.WindowIDArmour:
		return b.a.Armor().Inventory()
	case protocol.WindowIDUI:
		return b.ui
	}
	return nil
}

// slotFunc creates SlotFunc for the inventories.
func (b *Bot) slotFunc(id uint32, inv *inventory.Inventory) inventory.SlotFunc {
	// This is totally wrong.
	return func(slot int, before, after item.Stack) {
		it1, _ := b.ui.Item(0)
		it2, _ := inv.Item(slot)

		_ = b.ui.SetItem(0, it2)
		if !it1.Equal(after) {
			b.logger.Warn("unknown item source")
		}

		// avoiding sending actions from the server to the server.
		if b.handlingInventories {
			return
		}

		uiMapping, _ := b.inventoryMapping(b.ui)
		otherInvMapping, _ := b.inventoryMappingByID(id)

		var take protocol.TakeStackRequestAction
		{
			take.Count = byte(after.Count())
			take.Destination = uiMapping.slotInfo(0)
			take.Source = otherInvMapping.slotInfo(slot)
		}

		_ = b.conn.WritePacket(&packet.ItemStackRequest{Requests: []protocol.ItemStackRequest{
			{
				RequestID: 1,
				Actions:   []protocol.StackRequestAction{&take},
			},
		}})
	}
}
