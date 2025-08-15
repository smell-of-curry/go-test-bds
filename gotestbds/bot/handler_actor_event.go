package bot

import (
	"time"

	"github.com/sandertv/gophertunnel/minecraft/protocol/packet"
	"github.com/smell-of-curry/go-test-bds/gotestbds/actor"
)

// ActorEventHandler handlers ActorEvent packet.
type ActorEventHandler struct{}

// Handle ...
func (*ActorEventHandler) Handle(p packet.Packet, b *Bot, a *actor.Actor) error {
	actorEvent := p.(*packet.ActorEvent)

	switch actorEvent.EventType {
	case packet.ActorEventDeath:
		if a.RuntimeID() == actorEvent.EntityRuntimeID {
			time.AfterFunc(time.Second*3, func() {
				b.Execute(func(a *actor.Actor) {
					a.Respawn()
				})
			})
		}
	}
	return nil
}
