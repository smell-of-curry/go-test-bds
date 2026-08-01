package bot

import (
	"github.com/df-mc/dragonfly/server/block/cube"
	"github.com/go-gl/mathgl/mgl64"
	"github.com/sandertv/gophertunnel/minecraft/protocol/packet"
	"github.com/smell-of-curry/go-test-bds/gotestbds/actor"
	"github.com/smell-of-curry/go-test-bds/gotestbds/mcmath"
)

// ChangeDimensionHandler handles a dimension change from the server.
//
// The packet carries the destination Position. Ignoring it leaves the bot at
// the leaving-dimension feet (arena void coords after a battle return) until a
// later MovePlayer — and without PlayerActionDimensionChangeDone the server
// may never finish the transfer / stream destination chunks. Apply position,
// re-centre the load window, ack the loading screen, and AuthInput immediately
// (same post-teleport contract as MovePlayerHandler).
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

	pos := mcmath.Vec32To64(pk.Position)
	feet := pos.Sub(mgl64.Vec3{0, eyeOffset})
	a.Move(feet, a.Rotation())
	a.SetVelocity(mgl64.Vec3{})
	a.SetChunkLoadCenter(cube.PosFromVec3(feet))

	a.Handler().HandleChangeDimension(a, from, to)
	if err := a.AckDimensionChange(); err != nil {
		return err
	}
	a.SendMovement()
	return nil
}
