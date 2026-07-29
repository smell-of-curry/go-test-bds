package bot

import (
	"github.com/sandertv/gophertunnel/minecraft/protocol/packet"
	"github.com/smell-of-curry/go-test-bds/gotestbds/actor"
)

// SetTimeHandler tracks world time for the viewer sky.
type SetTimeHandler struct{}

// Handle applies a SetTime packet.
func (*SetTimeHandler) Handle(p packet.Packet, _ *Bot, a *actor.Actor) error {
	a.SetWorldTime(p.(*packet.SetTime).Time)
	return nil
}
