package bot

import (
	"fmt"

	"github.com/sandertv/gophertunnel/minecraft/protocol/packet"
	"github.com/smell-of-curry/go-test-bds/gotestbds/actor"
)

// ModalFormRequestHandler handles ModalFormRequest packet.
type ModalFormRequestHandler struct{}

// Handle ...
func (*ModalFormRequestHandler) Handle(p packet.Packet, b *Bot, a *actor.Actor) {
	request := p.(*packet.ModalFormRequest)
	f, err := actor.NewForm(request.FormData, request.FormID, b.Conn())
	if err != nil {
		b.logger.Error("error handling packet", "packet", fmt.Sprintf("%T", p), "error", err)
		return
	}
	a.ReceiveForm(f)
}
