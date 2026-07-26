package bot

import (
	"github.com/df-mc/dragonfly/server/block/cube"
	"github.com/sandertv/gophertunnel/minecraft/protocol"
	"github.com/sandertv/gophertunnel/minecraft/protocol/packet"
	"github.com/smell-of-curry/go-test-bds/gotestbds/actor"
)

// UpdateBlockHandler updates block in the Actor's world.
type UpdateBlockHandler struct{}

// Handle ...
func (*UpdateBlockHandler) Handle(p packet.Packet, b *Bot, a *actor.Actor) error {
	updateBlock := p.(*packet.UpdateBlock)

	a.World().SetBlockRuntimeID(
		blockPosToCubePos(updateBlock.Position),
		updateBlock.NewBlockRuntimeID,
		updateBlock.Layer,
	)
	return nil
}

func blockPosToCubePos(pos protocol.BlockPos) cube.Pos {
	return cube.Pos{int(pos[0]), int(pos[1]), int(pos[2])}
}
