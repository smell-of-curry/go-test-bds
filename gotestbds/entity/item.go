package entity

import (
	"github.com/df-mc/dragonfly/server/item"
)

// Item is an implementation of an item entity.
type Item struct {
	*Ent
	item item.Stack
}

// Item returns item.Stack.
func (i *Item) Item() item.Stack {
	return i.item
}

// Type ...
func (i *Item) Type() string {
	return "minecraft:item"
}
