package bot

import (
	"github.com/sandertv/gophertunnel/minecraft/protocol/packet"
	"github.com/smell-of-curry/go-test-bds/gotestbds/actor"
)

// AnimateHandler handles Animate packets (arm swings from other entities).
type AnimateHandler struct{}

// Handle records arm swings on the entity's state so the viewer can play a
// swing animation. Unknown entities and non-swing actions are ignored — the
// packet is cosmetic and arrives for entities outside tracking range too.
func (*AnimateHandler) Handle(p packet.Packet, b *Bot, a *actor.Actor) error {
	animate := p.(*packet.Animate)
	if animate.ActionType != packet.AnimateActionSwingArm {
		return nil
	}
	ent, ok := a.World().Entity(animate.EntityRuntimeID)
	if !ok {
		return nil
	}
	ent.State().NoteSwing()
	return nil
}
