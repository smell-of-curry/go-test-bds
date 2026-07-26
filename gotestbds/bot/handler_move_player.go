package bot

import (
	"github.com/df-mc/dragonfly/server/block/cube"
	"github.com/go-gl/mathgl/mgl64"
	"github.com/sandertv/gophertunnel/minecraft/protocol/packet"
	"github.com/smell-of-curry/go-test-bds/gotestbds/actor"
	"github.com/smell-of-curry/go-test-bds/gotestbds/mcmath"
)

// eyeOffset is the vertical offset Bedrock uses when it writes a player's
// position on the wire. Outgoing input applies it too, in Actor.SendMovement.
const eyeOffset = 1.62

// MovePlayerHandler handles the MovePlayer packet.
//
// A server-side teleport — a script's Player.teleport, /tp, a portal — reaches
// the moved client only through this packet. A bot that ignores it keeps
// simulating from where it last thought it was, so it reports a position the
// server left behind and every later assertion about where it stands is
// answered from that fiction.
type MovePlayerHandler struct{}

// Handle ...
func (*MovePlayerHandler) Handle(p packet.Packet, _ *Bot, a *actor.Actor) error {
	move := p.(*packet.MovePlayer)
	pos := mcmath.Vec32To64(move.Position)
	rot := cube.Rotation{float64(move.Yaw), float64(move.Pitch)}

	if move.EntityRuntimeID != a.RuntimeID() {
		if ent, ok := a.World().Entity(move.EntityRuntimeID); ok {
			ent.Move(pos, rot)
		}
		return nil
	}

	a.Move(pos.Sub(mgl64.Vec3{0, eyeOffset}), rot)
	// Whatever the bot was doing when the server moved it no longer applies:
	// keeping the velocity makes it carry a fall into its new position and drift
	// straight back out of wherever it was put.
	a.SetVelocity(mgl64.Vec3{})
	return nil
}
