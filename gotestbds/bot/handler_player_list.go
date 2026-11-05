package bot

import (
	"github.com/sandertv/gophertunnel/minecraft/protocol"
	"github.com/sandertv/gophertunnel/minecraft/protocol/packet"
	"github.com/smell-of-curry/go-test-bds/gotestbds/actor"
)

// PlayerListHandler tracks list membership without stripping visible NPC skins.
type PlayerListHandler struct{}

// Handle ...
func (*PlayerListHandler) Handle(p packet.Packet, b *Bot, a *actor.Actor) error {
	pk := p.(*packet.PlayerList)
	for i := range pk.Entries {
		e := &pk.Entries[i]
		switch e.ActionType {
		case protocol.PlayerListActionAdd:
			a.PlayerSkinListed(e.UUID)
			a.NoteSkin(e.UUID, e.Skin)
		case protocol.PlayerListActionRemove:
			a.ForgetSkin(e.UUID)
		}
	}
	return nil
}
