package actor

import (
	"github.com/sandertv/gophertunnel/minecraft/protocol/packet"
)

// prepare prepares Actor for interaction with the world.
func (a *Actor) prepare() {
	a.conn.WritePacket(&packet.ServerBoundLoadingScreen{Type: packet.LoadingScreenTypeEnd})
}
