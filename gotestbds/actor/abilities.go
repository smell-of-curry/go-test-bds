package actor

import (
	"fmt"
	"strings"

	"github.com/sandertv/gophertunnel/minecraft/protocol"
	"github.com/sandertv/gophertunnel/minecraft/protocol/packet"
)

// NoteAbilities records the latest UpdateAbilities snapshot.
//
// @param data Ability layers from the server.
// @returns true once, when a loading-screen layer is present, so the caller
// can finish the loading screen. A player stuck in that layer ignores movement.
func (a *Actor) NoteAbilities(data protocol.AbilityData) bool {
	var b strings.Builder
	fmt.Fprintf(&b, "p=%d/%d", data.PlayerPermissions, data.CommandPermissions)
	loading := false
	for _, layer := range data.Layers {
		fmt.Fprintf(&b, ",t%d:%x/%x", layer.Type, layer.Abilities, layer.Values)
		if layer.Type == protocol.AbilityLayerTypeLoadingScreen {
			loading = true
		}
	}
	a.abilityNote = b.String()
	if !loading || a.loadingAcked {
		return false
	}
	a.loadingAcked = true
	_ = a.conn.WritePacket(&packet.ServerBoundLoadingScreen{Type: packet.LoadingScreenTypeEnd})
	return true
}

// AbilityNote returns the compact ability snapshot for diagnostics.
//
// @returns "none" until the first UpdateAbilities, otherwise p=perm/cmd,tTYPE:bits/values.
func (a *Actor) AbilityNote() string {
	if a.abilityNote == "" {
		return "none"
	}
	return a.abilityNote
}
