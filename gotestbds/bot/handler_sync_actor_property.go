package bot

import (
	"github.com/sandertv/gophertunnel/minecraft/protocol/packet"
	"github.com/smell-of-curry/go-test-bds/gotestbds/actor"
)

// SyncActorPropertyHandler merges entity property definitions from the wire.
//
// No-op when wire registries have not been enabled (viewer off).
type SyncActorPropertyHandler struct{}

// Handle ...
func (*SyncActorPropertyHandler) Handle(p packet.Packet, _ *Bot, a *actor.Actor) error {
	a.ApplySyncActorProperty(p.(*packet.SyncActorProperty))
	return nil
}
