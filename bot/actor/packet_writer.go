package actor

import "github.com/sandertv/gophertunnel/minecraft/protocol/packet"

// PacketWriter provides way to send Actor's actions to the server.
type PacketWriter interface {
	WritePacket(pk packet.Packet) error
}
