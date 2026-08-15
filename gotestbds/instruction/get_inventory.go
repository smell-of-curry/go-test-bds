package instruction

import (
	"context"

	"github.com/smell-of-curry/go-test-bds/gotestbds/actor"
	"github.com/smell-of-curry/go-test-bds/gotestbds/bot"
	"github.com/smell-of-curry/go-test-bds/gotestbds/inventory"
)

// GetInventory returns the bot's inventory contents.
//
// The answer is the client-side mirror: what the server has actually sent this
// bot. BDS does not push inventory writes a script makes through the Script API
// (Container.setItem/addItem/swapItems, EntityEquippable.setEquipment) to the
// client at all — only a real inventory transaction, such as the /give and
// /replaceitem commands or a player-driven move, resyncs the window. Tests that
// need the mirror to catch up should force that resync server-side; the
// TypeScript Bot wrapper does it for them in getInventory.
type GetInventory struct {
	result any
}

// Name returns the instruction name.
func (*GetInventory) Name() string {
	return "getInventory"
}

// Run collects inventory, offhand, and armour contents.
func (g *GetInventory) Run(_ context.Context, b *bot.Bot) error {
	return execute(b, func(a *actor.Actor) error {
		out := map[string]any{
			"heldSlot": a.HeldSlot(),
			"items":    collectInventoryItems(a),
		}
		if off, ok := offhandItem(a); ok {
			out["offhand"] = off
		}
		if armour, ok := armourItems(a); ok {
			out["armour"] = armour
		}
		g.result = out
		return nil
	})
}

// Data returns the inventory payload from the last successful Run.
func (g *GetInventory) Data() any {
	return g.result
}

func collectInventoryItems(a *actor.Actor) []inventoryItemJSON {
	inv := a.Inventory()
	items := make([]inventoryItemJSON, 0, inv.Size())
	for slot := range inv.Size() {
		if it, ok := slotToInventoryItem(a, inv, slot, slot); ok {
			items = append(items, it)
		}
	}
	return items
}

func offhandItem(a *actor.Actor) (inventoryItemJSON, bool) {
	return slotToInventoryItem(a, a.Offhand(), 0, 0)
}

func armourItems(a *actor.Actor) (map[string]inventoryItemJSON, bool) {
	inv := a.Armour().Inventory()
	out := make(map[string]inventoryItemJSON)
	for slot, key := range []string{"helmet", "chestplate", "leggings", "boots"} {
		if it, ok := slotToInventoryItem(a, inv, slot, 0); ok {
			out[key] = it
		}
	}
	return out, len(out) > 0
}

// slotToInventoryItem reads one slot for the JSON payload.
//
// The name comes from the wire form and the server's own item registry, so an
// item the bot's item table cannot decode is still reported by name rather than
// silently read as an empty slot.
//
// @param a The actor whose registry names the item.
// @param inv The inventory to read.
// @param slot The slot to read.
// @param reportSlot The slot number to put in the payload.
// @returns the slot's JSON shape, and false when the slot is empty.
func slotToInventoryItem(a *actor.Actor, inv *inventory.Handle, slot, reportSlot int) (inventoryItemJSON, bool) {
	raw := inv.RawStack(slot)
	name := a.ItemStackName(raw)
	if name == "" {
		return inventoryItemJSON{}, false
	}

	out := inventoryItemJSON{Slot: reportSlot, Name: name, Count: int(raw.Count)}
	if decoded, err := inv.Item(slot); err == nil {
		if custom := decoded.CustomName(); custom != "" {
			out.CustomName = custom
		}
	}
	return out, true
}
