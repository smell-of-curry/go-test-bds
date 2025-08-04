package actor

import (
	"github.com/go-gl/mathgl/mgl32"
	"github.com/sandertv/gophertunnel/minecraft/protocol/packet"
)

// prepare prepares Actor for interaction wo
func (a *Actor) prepare() {
	a.conn.WritePacket(&packet.ServerBoundLoadingScreen{Type: 1})
	a.conn.WritePacket(&packet.Interact{ActionType: 0x4, TargetEntityRuntimeID: 0x0, Position: mgl32.Vec3{0, 0, 0}})
	a.conn.WritePacket(&packet.ServerBoundLoadingScreen{Type: 2})
	a.conn.WritePacket(&packet.PlayerAction{EntityRuntimeID: a.RuntimeID(), ActionType: 7, BlockFace: -1})
	a.conn.WritePacket(&packet.Interact{ActionType: 0x4})
	a.conn.WritePacket(&packet.ClientCameraAimAssist{PresetID: "", Action: 0x1})
}
