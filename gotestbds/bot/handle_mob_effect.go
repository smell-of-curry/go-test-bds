package bot

import (
	"fmt"
	"time"

	"github.com/df-mc/dragonfly/server/entity/effect"
	"github.com/sandertv/gophertunnel/minecraft/protocol/packet"
	"github.com/smell-of-curry/go-test-bds/gotestbds/actor"
)

// MobEffectHandler handles MobEffectPacket.
type MobEffectHandler struct{}

// Handle ...
func (*MobEffectHandler) Handle(p packet.Packet, b *Bot, a *actor.Actor) error {
	mobEffect := p.(*packet.MobEffect)
	if a.RuntimeID() != mobEffect.EntityRuntimeID {
		return nil
	}

	e, ok := effect.ByID(int(mobEffect.EffectType))
	if !ok {
		return fmt.Errorf("unknown effectID: %d", mobEffect.EffectType)
	}

	eff := e.(effect.LastingType)
	switch mobEffect.Operation {
	case packet.MobEffectAdd:
		a.AddEffect(effect.New(eff, int(mobEffect.Amplifier), time.Duration(mobEffect.Duration)*time.Second))
	case packet.MobEffectRemove:
		a.RemoveEffect(eff)
	case packet.MobEffectModify:
		a.AddEffect(effect.New(eff, int(mobEffect.Amplifier), time.Duration(mobEffect.Duration)*time.Second))
	}
	return nil
}
