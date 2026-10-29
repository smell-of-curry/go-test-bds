package instruction

import (
	"context"

	"github.com/sandertv/gophertunnel/minecraft/protocol/packet"
	"github.com/smell-of-curry/go-test-bds/gotestbds/actor"
	"github.com/smell-of-curry/go-test-bds/gotestbds/bot"
)

// SwingArm swings this bot's arm. The server relays the swing to nearby
// players, so other bots and the viewer see it; nothing is hit or used.
type SwingArm struct{}

// Name is the instruction name.
func (*SwingArm) Name() string { return "swingArm" }

// Run sends packet.Animate ActionSwingArm for the bot's own runtime id.
func (*SwingArm) Run(ctx context.Context, b *bot.Bot) error {
	_ = ctx
	return execute(b, func(a *actor.Actor) error {
		return a.WritePacket(SwingArmPacket(a.RuntimeID()))
	})
}

// SwingArmPacket builds a client arm swing.
func SwingArmPacket(runtimeID uint64) *packet.Animate {
	return &packet.Animate{ActionType: packet.AnimateActionSwingArm, EntityRuntimeID: runtimeID}
}
