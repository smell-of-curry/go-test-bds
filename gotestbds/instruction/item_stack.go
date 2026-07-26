package instruction

import "github.com/df-mc/dragonfly/server/item"

// inventoryItemJSON is a serializable inventory slot.
type inventoryItemJSON struct {
	Slot       int    `json:"slot"`
	Name       string `json:"name"`
	Count      int    `json:"count"`
	CustomName string `json:"customName,omitempty"`
}

// itemStackName returns the dragonfly identifier string for a stack.
func itemStackName(s item.Stack) string {
	if s.Empty() {
		return "minecraft:air"
	}
	name, _ := s.Item().EncodeItem()
	return name
}

// stackToInventoryItem converts a stack at slot into JSON shape, omitting empty stacks.
func stackToInventoryItem(slot int, s item.Stack) (inventoryItemJSON, bool) {
	if s.Empty() {
		return inventoryItemJSON{}, false
	}
	out := inventoryItemJSON{
		Slot:  slot,
		Name:  itemStackName(s),
		Count: s.Count(),
	}
	if name := s.CustomName(); name != "" {
		out.CustomName = name
	}
	return out, true
}
