package bot

import (
	"github.com/sandertv/gophertunnel/minecraft/protocol"
	"github.com/sandertv/gophertunnel/minecraft/protocol/packet"
	"github.com/smell-of-curry/go-test-bds/gotestbds/actor"
)

// ContainerOpenHandler handles ContainerOpen packet.
type ContainerOpenHandler struct{}

// Handle ...
func (*ContainerOpenHandler) Handle(p packet.Packet, b *Bot, a *actor.Actor) error {
	container := p.(*packet.ContainerOpen)

	// The player's own inventory is not a container the bot walked up to: the
	// server sends this window whenever the bot asks for an inventory sync, and
	// tracking it would leave every later read looking like a chest is open.
	if container.WindowID == protocol.WindowIDInventory {
		return nil
	}

	c := actor.NewContainerFromPacket(container, b, b.Conn())
	a.OpenContainer(c)

	b.currentContainerID = uint32(container.WindowID)
	b.currentContainer = c
	return nil
}
