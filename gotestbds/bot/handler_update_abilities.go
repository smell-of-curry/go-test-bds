package bot

import (
	"log/slog"

	"github.com/sandertv/gophertunnel/minecraft/protocol/packet"
	"github.com/smell-of-curry/go-test-bds/gotestbds/actor"
)

// UpdateAbilitiesHandler records the player's ability layers.
type UpdateAbilitiesHandler struct{}

// Handle stores ability bits and ends a lingering loading-screen layer.
//
// That layer is the spawn state BDS uses to ignore movement and block use.
// The initial loading-screen end can land before the layer arrives.
func (*UpdateAbilitiesHandler) Handle(p packet.Packet, b *Bot, a *actor.Actor) error {
	pk := p.(*packet.UpdateAbilities)
	if a.NoteAbilities(pk.AbilityData) && b != nil && b.logger != nil {
		b.logger.Info("GOTESTBDS_ABILITIES", slog.String("layers", a.AbilityNote()), slog.Bool("loadingEnd", true))
		return nil
	}
	if b != nil && b.logger != nil {
		b.logger.Info("GOTESTBDS_ABILITIES", slog.String("layers", a.AbilityNote()))
	}
	return nil
}
