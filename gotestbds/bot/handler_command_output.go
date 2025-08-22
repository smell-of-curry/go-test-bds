package bot

import (
	"github.com/sandertv/gophertunnel/minecraft/protocol/packet"
	"github.com/smell-of-curry/go-test-bds/gotestbds/actor"
)

// CommandOutputHandler handles CommandOutput packet.
type CommandOutputHandler struct{}

// Handle ...
func (*CommandOutputHandler) Handle(p packet.Packet, b *Bot, a *actor.Actor) error {
	output := p.(*packet.CommandOutput)
	a.ReceiveCommandOutput(output.OutputMessages)
	return nil
}
