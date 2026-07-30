package bot

import (
	"github.com/sandertv/gophertunnel/minecraft/protocol/packet"
	"github.com/smell-of-curry/go-test-bds/gotestbds/actor"
)

// TextHandler ...
type TextHandler struct{}

// Handle forwards packet.Text to the actor. Translation/tip/popup types carry
// Parameters (e.g. death.attack.inWall + player name); dropping them left the
// viewer's lang table with the key's template but no args ("%1$s suffocated…").
func (t TextHandler) Handle(p packet.Packet, b *Bot, a *actor.Actor) error {
	text := p.(*packet.Text)
	a.ReceiveMessage(text.Message, text.Parameters...)
	return nil
}
