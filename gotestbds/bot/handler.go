package bot

import (
	"github.com/sandertv/gophertunnel/minecraft/protocol/packet"
	"github.com/smell-of-curry/go-test-bds/gotestbds/actor"
)

// packetHandler represents a type that is able to handle a specific type of incoming packets from the server.
type packetHandler interface {
	Handle(p packet.Packet, b *Bot, a *actor.Actor)
}
