package bot

import (
	"github.com/sandertv/gophertunnel/minecraft/protocol/packet"
	"github.com/smell-of-curry/go-test-bds/gotestbds/actor"
)

// ChunkRadiusUpdatedHandler handles ChunkRadiusUpdated packet.
type ChunkRadiusUpdatedHandler struct{}

// Handle ...
func (*ChunkRadiusUpdatedHandler) Handle(p packet.Packet, b *Bot, a *actor.Actor) {
	chunkRadiusUpdated := p.(*packet.ChunkRadiusUpdated)
	a.SetChunkRadius(int(chunkRadiusUpdated.ChunkRadius))
}
