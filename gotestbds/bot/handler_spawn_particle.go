package bot

import (
	"github.com/sandertv/gophertunnel/minecraft/protocol/packet"
	"github.com/smell-of-curry/go-test-bds/gotestbds/actor"
)

// SpawnParticleEffectHandler records custom particle spawns for the viewer.
type SpawnParticleEffectHandler struct{}

// Handle stores one SpawnParticleEffect on the actor ring.
func (*SpawnParticleEffectHandler) Handle(p packet.Packet, _ *Bot, a *actor.Actor) error {
	pk := p.(*packet.SpawnParticleEffect)
	a.RecordParticleSpawn(pk.ParticleName, pk.Position, pk.Dimension, pk.EntityUniqueID)
	return nil
}
