package bot

import (
	"github.com/sandertv/gophertunnel/minecraft/protocol/packet"
	"github.com/smell-of-curry/go-test-bds/gotestbds/actor"
)

// UpdateSubChunkBlocksHandler applies a batch of block changes to the Actor's
// world.
//
// BDS sends this instead of UpdateBlock whenever more than one block in a
// sub-chunk changes at once, which includes the single-block case of a script
// calling Block.setType: the entry lands here, not in UpdateBlockHandler. A bot
// that ignores it keeps reporting the block the world had when the chunk
// arrived.
type UpdateSubChunkBlocksHandler struct{}

// Handle ...
func (*UpdateSubChunkBlocksHandler) Handle(p packet.Packet, _ *Bot, a *actor.Actor) error {
	update := p.(*packet.UpdateSubChunkBlocks)

	for _, entry := range update.Blocks {
		a.World().SetBlockRuntimeID(blockPosToCubePos(entry.BlockPos), entry.BlockRuntimeID, 0)
	}
	// Extra is the second layer, which is where waterlogging lives.
	for _, entry := range update.Extra {
		a.World().SetBlockRuntimeID(blockPosToCubePos(entry.BlockPos), entry.BlockRuntimeID, 1)
	}
	return nil
}
