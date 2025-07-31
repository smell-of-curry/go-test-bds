package actor

import (
	"github.com/sandertv/gophertunnel/minecraft"
	"github.com/sandertv/gophertunnel/minecraft/protocol/login"
	"github.com/sandertv/gophertunnel/minecraft/protocol/packet"
)

// Conn ...
type Conn interface {
	IdentityData() login.IdentityData
	WritePacket(pk packet.Packet) error
	GameData() minecraft.GameData
}
