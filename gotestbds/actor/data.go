package actor

import "github.com/df-mc/dragonfly/server/item/inventory"

// actorData ...
type actorData struct {
	slot    int
	inv     *inventory.Inventory
	offhand *inventory.Inventory
	armor   *inventory.Armour

	movementData
}
