package bot

import (
	"github.com/sandertv/gophertunnel/minecraft/protocol"
	"github.com/sandertv/gophertunnel/minecraft/protocol/packet"
	"github.com/smell-of-curry/go-test-bds/gotestbds/actor"
)

// ItemStackResponseHandler handlers ItemsStackResponse packet.
type ItemStackResponseHandler struct{}

// Handle ...
func (*ItemStackResponseHandler) Handle(p packet.Packet, b *Bot, a *actor.Actor) {
	itemStackResponse := p.(*packet.ItemStackResponse)
	for _, response := range itemStackResponse.Responses {
		if response.Status == protocol.ItemStackResponseStatusError {
			history := b.pendingItemStackResponses[response.RequestID]
			history.Revert()
		}
		delete(b.pendingItemStackResponses, response.RequestID)
	}
}
