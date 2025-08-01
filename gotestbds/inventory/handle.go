package inventory

import (
	"fmt"
	"github.com/df-mc/dragonfly/server/item"
	"github.com/df-mc/dragonfly/server/item/inventory"
	"github.com/sandertv/gophertunnel/minecraft/protocol"
	"github.com/smell-of-curry/go-test-bds/gotestbds/internal"
	"slices"
)

// Handle is a correct way to interact with inventories.
type Handle struct {
	inv *inventory.Inventory
	// stackIds is used to map item.Stack to its network id.
	stackIds []int32
	// containerID is an id of the inventory.
	containerID  uint32
	actionWriter ActionWriter
}

// NewHandle ...
func NewHandle(size int, containerID uint32, actionWriter ActionWriter) *Handle {
	return &Handle{
		inv:          inventory.New(size, nil),
		stackIds:     make([]int32, size),
		containerID:  containerID,
		actionWriter: actionWriter,
	}
}

// SetItem sets item in the slot passed, this function should not be called from anything other than the packet handler.
// For inventory interactions call Move, Swap or Drop.
func (source *Handle) SetItem(slot int, it protocol.ItemInstance) error {
	s := internal.StackToItem(it.Stack)
	err := source.inv.SetItem(slot, s)
	if err != nil {
		return err
	}
	// synchronizing network id's.
	source.stackIds[slot] = it.StackNetworkID
	return nil
}

// Item ...
func (source *Handle) Item(slot int) (item.Stack, error) {
	return source.inv.Item(slot)
}

// First ...
func (source *Handle) First(item item.Stack) (int, bool) {
	return source.inv.First(item)
}

// FirstFunc ...
func (source *Handle) FirstFunc(comparable func(stack item.Stack) bool) (int, bool) {
	return source.inv.FirstFunc(comparable)
}

// FirstEmpty ...
func (source *Handle) FirstEmpty() (int, bool) {
	return source.inv.FirstEmpty()
}

// ContainsItem ...
func (source *Handle) ContainsItem(it item.Stack) bool {
	return source.inv.ContainsItem(it)
}

// ContainsItemFunc ...
func (source *Handle) ContainsItemFunc(n int, comparable func(stack item.Stack) bool) bool {
	return source.inv.ContainsItemFunc(n, comparable)
}

// Empty ...
func (source *Handle) Empty() bool {
	return source.inv.Empty()
}

// String ...
func (source *Handle) String() string {
	return source.inv.String()
}

// ItemInstance returns protocol.ItemInstance.
func (source *Handle) ItemInstance(slot int) (protocol.ItemInstance, error) {
	s, err := source.stack(slot)
	if err != nil {
		return protocol.ItemInstance{}, err
	}
	it := internal.InstanceFromItem(s.s)
	it.StackNetworkID = s.id
	return it, err
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
		Container:      protocol.FullContainerName{ContainerID: byte(source.containerID)},
		Slot:           byte(slot),
		StackNetworkID: source.stackIds[slot],
	}
}

// stack ...
func (source *Handle) stack(slot int) (stack, error) {
	it, err := source.Item(slot)
	if err != nil {
		return stack{}, err
	}
	return stack{
		s:  it,
		id: source.stackIds[slot],
	}, nil
}

// newWriter creates new History writer.
func (*Handle) newWriter() (setItem func(slot int, it stack, handle *Handle) error, changes *History) {
	changes = &History{}
	setItem = func(slot int, it stack, handle *Handle) error {
		oldItem, _ := handle.Item(slot)
		err := handle.inv.SetItem(slot, it.s)
		if err != nil {
			return err
		}

		oldId := handle.stackIds[slot]
		handle.stackIds[slot] = it.id
		changes.writeChange(slot, oldItem, oldId, handle)

		return nil
	}
	return setItem, changes
}

// DropItem ...
func (source *Handle) DropItem(slot, count int) error {
	setItem, changes := source.newWriter()

	it, err := source.stack(slot)
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

	it, err := source.stack(sourceSlot)
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
	action.Destination.StackNetworkID = 0

	err = setItem(sourceSlot, it.Grow(-count), source)
	if err != nil {
		return err
	}

	source.actionWriter.WriteInventoryAction(action, changes)
	return nil
}

// Swap ...
// currently does not work.
func (source *Handle) Swap(sourceSlot, destinationSlot int, destination *Handle) error {
	setItem, changes := source.newWriter()

	it1, err := source.stack(sourceSlot)
	if err != nil {
		return fmt.Errorf("error swaping item (err: %w)", err)
	}

	it2, err := destination.stack(destinationSlot)
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

// Destroy destroys item in slot.
// It will work only if Actor has creative inventory access.
func (source *Handle) Destroy(slot, count int) {
	setItem, changes := source.newWriter()

	action := &protocol.DestroyStackRequestAction{}
	action.Count = byte(count)
	action.Source = source.slotInfo(slot)

	_ = setItem(slot, stack{}, source)
	source.actionWriter.WriteInventoryAction(action, changes)
}

// ActionWriter ...
type ActionWriter interface {
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
		handle := op.handle
		slot := op.slot
		_ = handle.inv.SetItem(slot, op.it.s)
		handle.stackIds[slot] = op.it.id
	}
}

// Size ...
func (c *History) Size() int {
	return len(c.operations)
}

// stack ...
type stack struct {
	s  item.Stack
	id int32
}

// Grow ...
func (s stack) Grow(n int) stack {
	s.s = s.s.Grow(n)
	return s
}

// Count ...
func (s stack) Count() int {
	return s.s.Count()
}

// writeChange ...
func (c *History) writeChange(slot int, it item.Stack, id int32, handle *Handle) {
	c.operations = append(c.operations, change{
		slot:   slot,
		it:     stack{it, id},
		handle: handle,
	})
}

// change ...
type change struct {
	slot   int
	it     stack
	handle *Handle
}
