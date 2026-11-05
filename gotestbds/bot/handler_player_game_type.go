package bot

import (
	"github.com/sandertv/gophertunnel/minecraft/protocol/packet"
	"github.com/smell-of-curry/go-test-bds/gotestbds/actor"
)

// SetPlayerGameTypeHandler applies the server's game mode to the local player.
// Abilities are carried separately; this only updates the observed game mode.
type SetPlayerGameTypeHandler struct{}

// Handle applies a SetPlayerGameType packet, which always targets this client.
func (*SetPlayerGameTypeHandler) Handle(p packet.Packet, b *Bot, a *actor.Actor) error {
	setLocalGameType(p.(*packet.SetPlayerGameType).GameType, b, a)
	return nil
}

// UpdatePlayerGameTypeHandler handles the addressed variant of SetPlayerGameType.
type UpdatePlayerGameTypeHandler struct{}

// Handle ignores updates addressed to another player's unique ID, as the native
// client does. Runtime IDs are not interchangeable with these world-unique IDs.
func (*UpdatePlayerGameTypeHandler) Handle(p packet.Packet, b *Bot, a *actor.Actor) error {
	pk := p.(*packet.UpdatePlayerGameType)
	if pk.PlayerUniqueID == a.UniqueID() {
		setLocalGameType(pk.GameType, b, a)
	}
	return nil
}

func setLocalGameType(gameType int32, b *Bot, a *actor.Actor) {
	if gameType == packet.GameTypeDefault {
		gameType = b.Conn().GameData().WorldGameMode
	}
	a.SetGamemode(int(gameType))
}
