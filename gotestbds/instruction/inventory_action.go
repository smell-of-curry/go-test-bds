package instruction

import (
	"context"
	"fmt"

	"github.com/smell-of-curry/go-test-bds/gotestbds/actor"
	"github.com/smell-of-curry/go-test-bds/gotestbds/bot"
	"github.com/smell-of-curry/go-test-bds/gotestbds/inventory"
)

const (
	Swap = "swap"
	Move = "move"
	Drop = "drop"
)

const (
	Inventory = "inventory"
	Offhand   = "offhand"
	Armour    = "armour"
	Ui        = "ui"
	Container = "container"
)

// InventoryAction performs inventory action.
type InventoryAction struct {
	Source      Slot   `json:"source"`
	Destination Slot   `json:"destination"`
	Action      string `json:"action"`
	Count       int    `json:"count"`
}

// Name ...
func (i *InventoryAction) Name() string {
	return "inventoryAction"
}

// Run ...
func (i *InventoryAction) Run(ctx context.Context, b *bot.Bot) error {
	return execute(b, func(a *actor.Actor) error {
		source, ok := invByName(a, i.Source.Inventory)
		if !ok {
			return fmt.Errorf("unknown inventory %s", i.Source.Inventory)
		}
		destination, hasDestination := invByName(a, i.Destination.Inventory)

		switch i.Action {
		case Drop:
			return source.DropItem(i.Source.Index, i.Count)
		case Move:
			if !hasDestination {
				return fmt.Errorf("unknown inventory %s", i.Destination.Inventory)
			}
			return source.Move(i.Source.Index, i.Destination.Index, i.Count, destination)
		case Swap:
			if !hasDestination {
				return fmt.Errorf("unknown inventory %s", i.Destination.Inventory)
			}
			return source.Swap(i.Source.Index, i.Destination.Index, destination)
		}
		return fmt.Errorf("unknow operation %s", i.Action)
	})
}

// Slot is a slot of the inventory.
type Slot struct {
	Index     int    `json:"index"`
	Inventory string `json:"inventory"`
}

// invByName returns inventory by name.
func invByName(a *actor.Actor, name string) (*inventory.Handle, bool) {
	switch name {
	case Inventory:
		return a.Inventory(), true
	case Offhand:
		return a.Offhand(), true
	case Armour:
		return a.Armour().Inventory(), true
	case Ui:
		return a.UiInv(), true
	case Container:
		c, ok := a.CurrentContainer()
		if !ok {
			return nil, false
		}
		return c.Inventory(), true
	}
	return nil, false
}
