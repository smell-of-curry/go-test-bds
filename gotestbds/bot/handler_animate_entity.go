package bot

import (
	"github.com/sandertv/gophertunnel/minecraft/protocol/packet"
	"github.com/smell-of-curry/go-test-bds/gotestbds/actor"
)

// AnimateEntityHandler records server-triggered entity animations
// (Script API playAnimation / the /playanimation command) for the viewer.
type AnimateEntityHandler struct{}

// Handle stores one AnimateEntity on the actor ring. The stream emits it
// on the event lane so a recording replays it on the same tick. An empty
// animation and controller, or a packet with no runtime ids, is ignored.
func (*AnimateEntityHandler) Handle(p packet.Packet, _ *Bot, a *actor.Actor) error {
	pk := p.(*packet.AnimateEntity)
	if pk.Animation == "" && pk.Controller == "" {
		return nil
	}
	if len(pk.EntityRuntimeIDs) == 0 {
		return nil
	}
	a.RecordEntityAnimate(actor.EntityAnimate{
		Animation:      pk.Animation,
		NextState:      pk.NextState,
		StopExpression: pk.StopCondition,
		Controller:     pk.Controller,
		BlendOutTime:   pk.BlendOutTime,
		RuntimeIDs:     append([]uint64(nil), pk.EntityRuntimeIDs...),
	})
	return nil
}
