package bot

import (
	"github.com/sandertv/gophertunnel/minecraft/protocol/packet"
	"github.com/smell-of-curry/go-test-bds/gotestbds/actor"
)

// TextHandler ...
type TextHandler struct{}

// Handle ...
func (t TextHandler) Handle(p packet.Packet, b *Bot, a *actor.Actor) error {
	text := p.(*packet.Text)
	a.ReceiveMessage(text.Message)
	return nil
}
