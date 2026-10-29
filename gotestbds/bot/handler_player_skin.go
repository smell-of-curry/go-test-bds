package bot

import (
	"github.com/sandertv/gophertunnel/minecraft/protocol/packet"
	"github.com/smell-of-curry/go-test-bds/gotestbds/actor"
)

// PlayerSkinHandler applies a skin change for a player already in the list.
type PlayerSkinHandler struct{}

// Handle ...
func (*PlayerSkinHandler) Handle(p packet.Packet, b *Bot, a *actor.Actor) error {
	pk := p.(*packet.PlayerSkin)
	a.NoteSkin(pk.UUID, pk.Skin)
	return nil
}
