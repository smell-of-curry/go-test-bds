package bot

import (
	"github.com/sandertv/gophertunnel/minecraft/protocol/packet"
	"github.com/smell-of-curry/go-test-bds/gotestbds/actor"
	"io"
)

// Conn ...
type Conn interface {
	actor.Conn
	io.Closer
	ReadPacket() (pk packet.Packet, err error)
}
