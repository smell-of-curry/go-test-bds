package bot

import (
	"github.com/sandertv/gophertunnel/minecraft/protocol"
	"github.com/sandertv/gophertunnel/minecraft/protocol/packet"
	"github.com/smell-of-curry/go-test-bds/gotestbds/actor"
)

// SetActorLinkHandler tracks rider links and this bot’s vehicle input state.
//
// Ride input (ClientPredictedVehicle on PlayerAuthInput) is only meaningful
// while the server has actually linked the player to a vehicle. Without this,
// a right-click that mounts on the server is invisible to later steer ticks.
type SetActorLinkHandler struct{}

// Handle ...
func (*SetActorLinkHandler) Handle(p packet.Packet, _ *Bot, a *actor.Actor) error {
	link := p.(*packet.SetActorLink).EntityLink
	// Record other riders too so observers can render mounted entities.
	if ent, ok := a.World().EntityByUniqueID(link.RiderEntityUniqueID); ok {
		if setter, ok := ent.(interface{ SetVehicle(int64) }); ok {
			switch link.Type {
			case protocol.EntityLinkRemove:
				setter.SetVehicle(0)
			case protocol.EntityLinkRider, protocol.EntityLinkPassenger:
				setter.SetVehicle(link.RiddenEntityUniqueID)
			}
		}
	}
	if link.RiderEntityUniqueID != a.UniqueID() {
		return nil
	}
	switch link.Type {
	case protocol.EntityLinkRemove:
		a.ClearVehicle()
	case protocol.EntityLinkRider, protocol.EntityLinkPassenger:
		a.SetVehicle(link.RiddenEntityUniqueID)
	}
	return nil
}
