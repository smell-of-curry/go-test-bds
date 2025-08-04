package actor

import (
	"github.com/sandertv/gophertunnel/minecraft/protocol"
	"github.com/sandertv/gophertunnel/minecraft/protocol/packet"
)

// prepare prepares Actor for interaction with the world.
func (a *Actor) prepare() {
	a.conn.WritePacket(&packet.ServerBoundLoadingScreen{Type: packet.LoadingScreenTypeStart})
	a.conn.WritePacket(&packet.Interact{ActionType: packet.InteractActionMouseOverEntity})
	a.conn.WritePacket(&packet.ServerBoundLoadingScreen{Type: packet.LoadingScreenTypeEnd})
	a.conn.WritePacket(&packet.PlayerAction{EntityRuntimeID: a.RuntimeID(), ActionType: protocol.PlayerActionRespawn, BlockFace: -1})
	a.conn.WritePacket(&packet.Interact{ActionType: packet.InteractActionMouseOverEntity})
	a.conn.WritePacket(&packet.ClientCameraAimAssist{Action: packet.ClientCameraAimAssistActionClear})
}
