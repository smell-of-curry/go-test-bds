package bot

import (
	"fmt"

	"github.com/df-mc/dragonfly/server/block/cube"
	w "github.com/df-mc/dragonfly/server/world"
	"github.com/sandertv/gophertunnel/minecraft/protocol/packet"
	"github.com/smell-of-curry/go-test-bds/gotestbds/actor"
)

// BlockActorDataHandler handles BlockActorData packet.
type BlockActorDataHandler struct{}

// Handle ...
func (*BlockActorDataHandler) Handle(p packet.Packet, b *Bot, a *actor.Actor) error {
	blockActorData := p.(*packet.BlockActorData)
	pos := cube.Pos{int(blockActorData.Position[0]), int(blockActorData.Position[1]), int(blockActorData.Position[2])}
	bl := a.World().Block(pos)
	encodable, ok := bl.(w.NBTer)
	if !ok {
		return fmt.Errorf("block at position %v does not implements world.NBTer interface", pos)
	}
	newBlock := encodable.DecodeNBT(blockActorData.NBTData).(w.Block)
	a.World().SetBlock(pos, newBlock)
	return nil
}
