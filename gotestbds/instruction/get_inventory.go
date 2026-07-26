package instruction

import (
	"context"

	"github.com/df-mc/dragonfly/server/item"
	"github.com/smell-of-curry/go-test-bds/gotestbds/actor"
	"github.com/smell-of-curry/go-test-bds/gotestbds/bot"
)

// GetInventory returns the bot's inventory contents.
type GetInventory struct {
	result any
}

// Name returns the instruction name.
func (*GetInventory) Name() string {
	return "getInventory"
}

// Run collects inventory, offhand, and armour contents.
func (g *GetInventory) Run(ctx context.Context, b *bot.Bot) error {
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
	slots := a.Inventory().Slots()
	items := make([]inventoryItemJSON, 0, len(slots))
	for i, s := range slots {
		if it, ok := stackToInventoryItem(i, s); ok {
			items = append(items, it)
		}
	}
	return items
}

func offhandItem(a *actor.Actor) (inventoryItemJSON, bool) {
	s, err := a.Offhand().Item(0)
	if err != nil {
		return inventoryItemJSON{}, false
	}
	return stackToInventoryItem(0, s)
}

func armourItems(a *actor.Actor) (map[string]inventoryItemJSON, bool) {
	arm := a.Armour()
	out := make(map[string]inventoryItemJSON)
	add := func(key string, s item.Stack) {
		if it, ok := stackToInventoryItem(0, s); ok {
			out[key] = it
		}
	}
	add("helmet", arm.Helmet())
	add("chestplate", arm.Chestplate())
	add("leggings", arm.Leggings())
	add("boots", arm.Boots())
	return out, len(out) > 0
}
