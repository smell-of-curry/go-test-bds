package bot

import (
	"github.com/sandertv/gophertunnel/minecraft/protocol/packet"
	"github.com/smell-of-curry/go-test-bds/gotestbds/actor"
)

// ContainerCloseHandler handles ContainerClose packet.
type ContainerCloseHandler struct{}

// Handle ...
func (*ContainerCloseHandler) Handle(p packet.Packet, b *Bot, a *actor.Actor) error {
	containerClose := p.(*packet.ContainerClose)
	if b.currentContainerID != uint32(containerClose.WindowID) || b.currentContainer == nil {
		return nil
	}
	b.currentContainer = nil
	container, ok := a.CurrentContainer()
	if ok {
		return container.Close()
	}
	return nil
}
