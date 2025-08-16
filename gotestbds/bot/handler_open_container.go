package bot

import (
	"github.com/sandertv/gophertunnel/minecraft/protocol/packet"
	"github.com/smell-of-curry/go-test-bds/gotestbds/actor"
)

// ContainerOpenHandler handles ContainerOpen packet.
type ContainerOpenHandler struct{}

// Handle ...
func (*ContainerOpenHandler) Handle(p packet.Packet, b *Bot, a *actor.Actor) error {
	container := p.(*packet.ContainerOpen)

	c := actor.NewContainerFromPacket(container, b, b.Conn())
	a.OpenContainer(c)

	b.currentContainerID = uint32(container.WindowID)
	b.currentContainer = c
	return nil
}
