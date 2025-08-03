package bot

import (
	"github.com/df-mc/dragonfly/server/block/cube"
	"github.com/sandertv/gophertunnel/minecraft/protocol/packet"
	"github.com/smell-of-curry/go-test-bds/gotestbds/actor"
)

// NetworkChunkPublisherUpdateHandler handles NetworkChunkPublisherUpdate packet.
type NetworkChunkPublisherUpdateHandler struct{}

// Handle ...
func (*NetworkChunkPublisherUpdateHandler) Handle(p packet.Packet, b *Bot, a *actor.Actor) {
	pk := p.(*packet.NetworkChunkPublisherUpdate)
	pos := pk.Position
	a.SetChunkLoadCenter(cube.Pos{int(pos[0]), int(pos[1]), int(pos[2])})
	a.SetChunkRadius(int(pk.Radius << 4))
}
