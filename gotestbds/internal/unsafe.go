package internal

import (
	"github.com/df-mc/dragonfly/server/item"
	"github.com/sandertv/gophertunnel/minecraft/protocol"
	_ "unsafe"
)

//go:linkname StackToItem github.com/df-mc/dragonfly/server/session.stackToItem
func StackToItem(it protocol.ItemStack) item.Stack

//go:linkname InstanceFromItem github.com/df-mc/dragonfly/server/session.instanceFromItem
func InstanceFromItem(it item.Stack) protocol.ItemInstance
