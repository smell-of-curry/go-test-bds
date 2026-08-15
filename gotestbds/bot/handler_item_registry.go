package bot

import (
	"github.com/sandertv/gophertunnel/minecraft/protocol/packet"
	"github.com/smell-of-curry/go-test-bds/gotestbds/actor"
)

// ItemRegistryHandler merges a late ItemRegistry into wire registries.
//
// The join-sequence ItemRegistry is consumed by gophertunnel into GameData.Items
// before the bot reads packets; EnsureWireRegistries seeds from that. This
// handler covers any post-spawn re-send and is a no-op when registries are off.
type ItemRegistryHandler struct{}

// Handle ...
func (*ItemRegistryHandler) Handle(p packet.Packet, _ *Bot, a *actor.Actor) error {
	a.ApplyItemRegistry(p.(*packet.ItemRegistry))
	return nil
}
