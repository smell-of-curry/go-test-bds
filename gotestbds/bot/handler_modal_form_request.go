package bot

import (
	"fmt"

	"github.com/sandertv/gophertunnel/minecraft/protocol"
	"github.com/sandertv/gophertunnel/minecraft/protocol/packet"
	"github.com/smell-of-curry/go-test-bds/gotestbds/actor"
)

// ModalFormRequestHandler handles ModalFormRequest packet.
type ModalFormRequestHandler struct{}

// Handle ...
func (*ModalFormRequestHandler) Handle(p packet.Packet, b *Bot, a *actor.Actor) error {
	request := p.(*packet.ModalFormRequest)
	if _, ok := a.LastForm(); ok {
		_ = b.Conn().WritePacket(&packet.ModalFormResponse{FormID: request.FormID, CancelReason: protocol.Option(uint8(packet.ModalFormCancelReasonUserBusy))})
		return fmt.Errorf("unable to receive form, client is busy")
	}
	f, err := actor.NewForm(request.FormData, request.FormID, b.Conn())
	if err != nil {
		return err
	}
	a.ReceiveForm(f)
	return nil
}
