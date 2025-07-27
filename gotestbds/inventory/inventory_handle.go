package inventory

import (
	"fmt"
	"github.com/df-mc/dragonfly/server/item"
	"github.com/df-mc/dragonfly/server/item/inventory"
	"github.com/sandertv/gophertunnel/minecraft/protocol"
	"slices"
)

// Handle is a correct way to interact with inventories.
type Handle struct {
	inv *inventory.Inventory
	// stackIds is used to map item.Stack to its network id.
	stackIds []int32
	// windowID is an id of the inventory.
	windowID     uint32
	actionWriter InventoryActionWriter
}

// SetItem sets item in the slot passed, this function should not be called from anything other than the packet handler.
// For inventory interactions call Move, Swap or Drop.
func (source *Handle) SetItem(slot int, it item.Stack, stackId int32) error {
	err := source.inv.SetItem(slot, it)
	if err != nil {
		return err
	}
	// synchronizing network id's.
	source.stackIds[slot] = stackId
	return nil
}

// Item ...
func (source *Handle) Item(slot int) (item.Stack, error) {
	return source.inv.Item(slot)
}

// Slots ...
func (source *Handle) Slots() []item.Stack {
	return source.inv.Slots()
}

// Size ...
func (source *Handle) Size() int {
	return source.inv.Size()
}

// slotInfo ...
func (source *Handle) slotInfo(slot int) protocol.StackRequestSlotInfo {
	return protocol.StackRequestSlotInfo{
		Container:      protocol.FullContainerName{ContainerID: byte(source.windowID)},
		Slot:           byte(slot),
		StackNetworkID: source.stackIds[slot],
	}
}

// newWriter creates
func (*Handle) newWriter() (setItem func(slot int, it item.Stack, handle *Handle) error, changes *History) {
	changes = &History{}
	setItem = func(slot int, it item.Stack, handle *Handle) error {
		oldItem, _ := handle.Item(slot)
		err := handle.inv.SetItem(slot, it)
		if err != nil {
			return err
		}

		changes.writeChange(slot, oldItem, handle)
		return nil
	}
	return setItem, changes
}

// DropItem ...
func (source *Handle) DropItem(slot, count int) error {
	setItem, changes := source.newWriter()

	it, err := source.Item(slot)
	if err != nil {
		return fmt.Errorf("error droping item (err: %w)", err)
	}

	_ = setItem(slot, it.Grow(-count), source)
	action := &protocol.DropStackRequestAction{}
	action.Count = byte(count)
	action.Source = source.slotInfo(slot)

	source.actionWriter.WriteInventoryAction(action, changes)
	return nil
}

// Move ...
func (source *Handle) Move(sourceSlot, destinationSlot, count int, destination *Handle) error {
	setItem, changes := source.newWriter()

	it, err := source.Item(sourceSlot)
	if err != nil {
		return fmt.Errorf("error moving item (err: %w)", err)
	}

	left := it.Count() - count
	err = setItem(destinationSlot, it.Grow(-left), destination)
	if err != nil {
		return fmt.Errorf("error moving item (err: %w)", err)
	}

	action := &protocol.PlaceStackRequestAction{}
	action.Count = byte(count)
	action.Source = source.slotInfo(sourceSlot)
	action.Destination = destination.slotInfo(destinationSlot)

	err = setItem(sourceSlot, it.Grow(-count), source)
	if err != nil {
		return err
	}

	source.actionWriter.WriteInventoryAction(action, changes)
	return nil
}

// Swap ...
func (source *Handle) Swap(sourceSlot, destinationSlot int, destination *Handle) error {
	setItem, changes := source.newWriter()

	it1, err := source.Item(sourceSlot)
	if err != nil {
		return fmt.Errorf("error swaping item (err: %w)", err)
	}

	it2, err := destination.Item(destinationSlot)
	if err != nil {
		return fmt.Errorf("error swaping item (err: %w)", err)
	}

	action := &protocol.SwapStackRequestAction{}
	action.Source = source.slotInfo(sourceSlot)
	action.Destination = destination.slotInfo(destinationSlot)

	_ = setItem(sourceSlot, it2, source)
	_ = setItem(destinationSlot, it1, destination)

	source.actionWriter.WriteInventoryAction(action, changes)
	return nil
}

// InventoryActionWriter ...
type InventoryActionWriter interface {
	WriteInventoryAction(action protocol.StackRequestAction, changes *History)
}

// History is a record of changes.
type History struct {
	operations []change
}

// Revert reverts changes.
func (c *History) Revert() {
	slices.Reverse(c.operations)
	for _, op := range c.operations {
		_ = op.handle.inv.SetItem(op.slot, op.it)
	}
}

// Size ...
func (c *History) Size() int {
	return len(c.operations)
}

// writeChange ...
func (c *History) writeChange(slot int, it item.Stack, handle *Handle) {
	c.operations = append(c.operations, change{
		slot:   slot,
		it:     it,
		handle: handle,
	})
}

type change struct {
	slot   int
	it     item.Stack
	handle *Handle
}
