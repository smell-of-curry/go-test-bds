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
//
// After applying the move the bot must also:
//   - re-centre its own chunk unload window on the new position (the next
//     NetworkChunkPublisherUpdate usually follows, but LevelChunks for the
//     destination can arrive first — and unloadChunks would discard them as
//     too far from the old centre), and
//   - send a PlayerAuthInput at the new position immediately. Servers (BDS
//     included) gate post-teleport chunk streaming on the client reporting
//     itself there; waiting for the next Tick leaves a window where the
//     server keeps publishing around the old position while the bot's prune
//     window already moved — exactly the "columns → 0, never recovers"
//     failure after a long-distance teleport.
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

	feet := pos.Sub(mgl64.Vec3{0, eyeOffset})
	a.Move(feet, rot)
	// Whatever the bot was doing when the server moved it no longer applies:
	// keeping the velocity makes it carry a fall into its new position and drift
	// straight back out of wherever it was put.
	a.SetVelocity(mgl64.Vec3{})
	a.SetChunkLoadCenter(cube.PosFromVec3(feet))
	a.SendMovement()
	return nil
}
