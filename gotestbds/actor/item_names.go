package actor

import (
	"fmt"

	"github.com/sandertv/gophertunnel/minecraft/protocol"
)

// ItemName names an item the way the server does.
//
// Item network IDs are assigned by the server and handed to the client in the
// StartGame item registry, so an addon (or any version drift) shifts them away
// from whatever table the bot was built with. Reading the registry the server
// actually sent is the only way to name items reliably — and it is the only way
// to name custom items at all.
//
// @param networkID The item's network ID as it appeared on the wire.
// @returns the item's identifier, or "unknown:<id>" when the server never
// mentioned it.
func (a *Actor) ItemName(networkID int32) string {
	if a.itemNames == nil {
		items := a.conn.GameData().Items
		a.itemNames = make(map[int32]string, len(items))
		for _, entry := range items {
			a.itemNames[int32(entry.RuntimeID)] = entry.Name
		}
	}
	if name, ok := a.itemNames[networkID]; ok {
		return name
	}
	return fmt.Sprintf("unknown:%d", networkID)
}

// ItemStackName names a stack as it arrived over the network.
//
// @param stack The wire form of the stack.
// @returns the item's identifier, or an empty string for an empty slot.
func (a *Actor) ItemStackName(stack protocol.ItemStack) string {
	if stack.NetworkID == 0 || stack.Count == 0 {
		return ""
	}
	return a.ItemName(stack.NetworkID)
}
