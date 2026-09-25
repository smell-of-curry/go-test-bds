package bot

import (
	"github.com/sandertv/gophertunnel/minecraft/protocol"
	"github.com/sandertv/gophertunnel/minecraft/protocol/packet"
	"github.com/smell-of-curry/go-test-bds/gotestbds/actor"
)

// SetActorLinkHandler tracks when the server mounts or dismounts this bot.
//
// Ride input (ClientPredictedVehicle on PlayerAuthInput) is only meaningful
// while the server has actually linked the player to a vehicle. Without this,
// a right-click that mounts on the server is invisible to later steer ticks.
type SetActorLinkHandler struct{}

// Handle ...
func (*SetActorLinkHandler) Handle(p packet.Packet, _ *Bot, a *actor.Actor) error {
	link := p.(*packet.SetActorLink).EntityLink
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
