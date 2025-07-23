package bot

import (
	"github.com/sandertv/gophertunnel/minecraft/protocol/packet"
	"pokebedrock_testing_bot/bot/actor"
)

// packetHandler represents a type that is able to handle a specific type of incoming packets from the server.
type packetHandler interface {
	Handle(p packet.Packet, b *Bot, a *actor.Actor)
}
