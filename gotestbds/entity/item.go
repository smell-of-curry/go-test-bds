package entity

import "github.com/sandertv/gophertunnel/minecraft/protocol"

// Item is an implementation of an item entity.
type Item struct {
	*Ent
	item protocol.ItemInstance
}

// Item ...
func (i *Item) Item() protocol.ItemInstance {
	return i.item
}

// Type ...
func (i *Item) Type() string {
	return "minecraft:item"
}
