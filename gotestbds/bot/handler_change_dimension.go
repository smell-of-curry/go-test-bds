package bot

import (
	"github.com/sandertv/gophertunnel/minecraft/protocol/packet"
	"github.com/smell-of-curry/go-test-bds/gotestbds/actor"
)

// ChangeDimensionHandler handles a dimension change from the server.
type ChangeDimensionHandler struct{}

// Handle ...
func (*ChangeDimensionHandler) Handle(p packet.Packet, _ *Bot, a *actor.Actor) error {
	pk := p.(*packet.ChangeDimension)
	from := a.World().Dimension()
	to := pk.Dimension
	// Columns from the dimension we are leaving are not valid in the
	// destination — keep them and the same ChunkPos reads the wrong world.
	a.World().FlushChunks()
	a.World().FlushEntities(a.RuntimeID())
	a.World().SetDimension(to)
	a.Handler().HandleChangeDimension(a, from, to)
	return nil
}
