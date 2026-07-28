package bot

import (
	"github.com/df-mc/dragonfly/server/block/cube"
	"github.com/sandertv/gophertunnel/minecraft/protocol/packet"
	"github.com/smell-of-curry/go-test-bds/gotestbds/actor"
)

// NetworkChunkPublisherUpdateHandler handles NetworkChunkPublisherUpdate packet.
//
// Radius on the wire is in blocks (chunk radius << 4). unloadChunks compares
// chunk-coordinate distance against Actor.ChunkRadius, which is in chunks —
// so the block radius must be shifted back down, not up. The old `<< 4`
// turned an 8-chunk view into a 2048-chunk one (pruning never fired) or, once
// corrected elsewhere, left the units mismatched with ChunkRadiusUpdated.
type NetworkChunkPublisherUpdateHandler struct{}

// Handle ...
func (*NetworkChunkPublisherUpdateHandler) Handle(p packet.Packet, b *Bot, a *actor.Actor) error {
	pk := p.(*packet.NetworkChunkPublisherUpdate)
	pos := pk.Position
	a.SetChunkLoadCenter(cube.Pos{int(pos[0]), int(pos[1]), int(pos[2])})
	a.SetChunkRadius(int(pk.Radius >> 4))
	return nil
}
