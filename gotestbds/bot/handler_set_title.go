package bot

import (
	"github.com/sandertv/gophertunnel/minecraft/protocol/packet"
	"github.com/smell-of-curry/go-test-bds/gotestbds/actor"
)

// SetTitleHandler tracks title / subtitle / action-bar text for the viewer HUD.
type SetTitleHandler struct{}

// Handle applies one SetTitle packet to the actor's screen-title state.
func (*SetTitleHandler) Handle(p packet.Packet, _ *Bot, a *actor.Actor) error {
	pk := p.(*packet.SetTitle)
	a.ApplyTitleAction(pk.ActionType, pk.Text, pk.FadeInDuration, pk.RemainDuration, pk.FadeOutDuration)
	return nil
}
