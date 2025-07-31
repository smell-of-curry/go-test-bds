package inventory

import (
	"github.com/df-mc/dragonfly/server/item"
	"github.com/sandertv/gophertunnel/minecraft/protocol"
)

// Armour ...
type Armour struct {
	inv *Handle
}

// NewArmour ...
func NewArmour(writer ActionWriter) *Armour {
	return &Armour{NewHandle(4, protocol.WindowIDArmour, writer)}
}

// Helmet returns the item stack set as helmet in the inventory.
func (a *Armour) Helmet() item.Stack {
	i, _ := a.inv.Item(0)
	return i
}

// Chestplate returns the item stack set as chestplate in the inventory.
func (a *Armour) Chestplate() item.Stack {
	i, _ := a.inv.Item(1)
	return i
}

// Leggings returns the item stack set as leggings in the inventory.
func (a *Armour) Leggings() item.Stack {
	i, _ := a.inv.Item(2)
	return i
}

// Boots returns the item stack set as boots in the inventory.
func (a *Armour) Boots() item.Stack {
	i, _ := a.inv.Item(3)
	return i
}

// Inventory ...
func (a *Armour) Inventory() *Handle {
	return a.inv
}
