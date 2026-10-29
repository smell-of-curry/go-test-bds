package bot

import (
	"github.com/sandertv/gophertunnel/minecraft/protocol/packet"
	"github.com/smell-of-curry/go-test-bds/gotestbds/actor"
)

// emoteTarget is an entity that can show an emote in the viewer snapshot.
type emoteTarget interface {
	SetEmote(id string, startTick uint64)
}

// EmoteHandler records an emote on the entity it names.
// The field stays until a newer emote or the entity is removed.
type EmoteHandler struct{}

// Handle ...
func (*EmoteHandler) Handle(p packet.Packet, b *Bot, a *actor.Actor) error {
	pk := p.(*packet.Emote)
	ent, ok := a.World().Entity(pk.EntityRuntimeID)
	if !ok {
		return nil
	}
	target, ok := ent.(emoteTarget)
	if !ok {
		return nil
	}
	target.SetEmote(pk.EmoteID, a.CurrentTick())
	return nil
}
