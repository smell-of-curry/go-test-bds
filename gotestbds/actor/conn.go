package actor

import (
	"github.com/sandertv/gophertunnel/minecraft"
	"github.com/sandertv/gophertunnel/minecraft/protocol/login"
	"github.com/sandertv/gophertunnel/minecraft/protocol/packet"
)

// Conn is the way to Actor to interact with the server.
type Conn interface {
	IdentityData() login.IdentityData
	WritePacket(pk packet.Packet) error
	GameData() minecraft.GameData
}
