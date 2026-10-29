package bot

import (
	"github.com/go-gl/mathgl/mgl64"
	"github.com/sandertv/gophertunnel/minecraft/protocol/packet"
	"github.com/smell-of-curry/go-test-bds/gotestbds/actor"
	"github.com/smell-of-curry/go-test-bds/gotestbds/entity"
)

// MoveActorDeltaHandler handles the MoveActorDelta packet: BDS's usual way to
// move and turn mobs. Every field is absolute; absent fields keep their value.
type MoveActorDeltaHandler struct{}

// Handle ...
func (MoveActorDeltaHandler) Handle(p packet.Packet, _ *Bot, a *actor.Actor) error {
	pk := p.(*packet.MoveActorDelta)
	ent, ok := a.World().Entity(pk.EntityRuntimeID)
	if !ok {
		return nil
	}
	pos, rot := ent.Position(), ent.Rotation()
	if x, ok := pk.PositionX.Value(); ok {
		pos[0] = float64(x)
	}
	if y, ok := pk.PositionY.Value(); ok {
		pos[1] = entity.FeetOf(ent, mgl64.Vec3{0, float64(y)})[1]
	}
	if z, ok := pk.PositionZ.Value(); ok {
		pos[2] = float64(z)
	}
	if pitch, ok := pk.RotationX.Value(); ok {
		rot[1] = float64(pitch)
	}
	if yaw, ok := pk.RotationY.Value(); ok {
		rot[0] = float64(yaw)
	}
	ent.Move(pos, rot)
	if yaw, ok := pk.RotationYHead.Value(); ok {
		setHeadYaw(ent, float64(yaw))
	}
	return nil
}
