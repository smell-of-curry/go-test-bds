package bot

import (
	"fmt"

	"github.com/df-mc/dragonfly/server/block/cube"
	"github.com/df-mc/dragonfly/server/world"
	"github.com/sandertv/gophertunnel/minecraft/protocol/packet"
	"github.com/smell-of-curry/go-test-bds/gotestbds/actor"
)

// OpenSignHandler handles OpenSign packet.
type OpenSignHandler struct{}

// Handle ...
func (*OpenSignHandler) Handle(p packet.Packet, b *Bot, a *actor.Actor) error {
	openSign := p.(*packet.OpenSign)
	pos := cube.Pos{int(openSign.Position[0]), int(openSign.Position[1]), int(openSign.Position[2])}
	bl := a.World().Block(pos)

	nbter, ok := bl.(world.NBTer)
	if !ok {
		return fmt.Errorf("block %T does not implement world.NBTer interface", bl)
	}

	sign := actor.NewSign(nbter, pos, openSign.FrontSide, b.conn)
	a.ReceiveSign(sign)
	return nil
}
