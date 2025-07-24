package bot

import (
	"github.com/df-mc/dragonfly/server/block/cube"
	"github.com/df-mc/dragonfly/server/world"
	"github.com/sandertv/gophertunnel/minecraft/protocol"
	"github.com/sandertv/gophertunnel/minecraft/protocol/packet"
	"github.com/smell-of-curry/go-test-bds/gotestbds/actor"
)

// UpdateBlockHandler updates block in the Actor's world.
type UpdateBlockHandler struct{}

// Handle ...
func (UpdateBlockHandler) Handle(p packet.Packet, b *Bot, a *actor.Actor) {
	updateBlock := p.(*packet.UpdateBlock)
	if updateBlock.Layer != 0 {
		return
	}

	bl, _ := world.BlockByRuntimeID(updateBlock.NewBlockRuntimeID)
	a.World().SetBlock(blockPosToCubePos(updateBlock.Position), bl)
}

func blockPosToCubePos(pos protocol.BlockPos) cube.Pos {
	return cube.Pos{int(pos[0]), int(pos[1]), int(pos[2])}
}
