package instruction

import (
	"context"

	"github.com/sandertv/gophertunnel/minecraft/protocol/packet"
	"github.com/smell-of-curry/go-test-bds/gotestbds/actor"
	"github.com/smell-of-curry/go-test-bds/gotestbds/bot"
)

// DefaultEmoteID is the vanilla wave emote.
const DefaultEmoteID = "4c8ae710-df2e-47cd-814d-cc7bf21a3d67"

// emoteLengthTicks is how long the sent packet says the emote lasts.
// The snapshot keeps its own startTick; renderers decide playback.
const emoteLengthTicks = 40

// Emote plays an emote on this bot. An empty emoteId uses DefaultEmoteID.
// Flags leave EmoteFlagServerSide unset — this packet is from the client.
type Emote struct {
	EmoteID string `json:"emoteId"`
}

// Name is the instruction name.
func (*Emote) Name() string { return "emote" }

// Run sends packet.Emote for the bot's own runtime id and stamps the local
// player entity so this bot's snapshot shows the emote without waiting for
// the server to echo it.
func (e *Emote) Run(ctx context.Context, b *bot.Bot) error {
	_ = ctx
	return execute(b, func(a *actor.Actor) error {
		pk := EmotePacket(a.RuntimeID(), e.EmoteID)
		if err := a.WritePacket(pk); err != nil {
			return err
		}
		a.SetEmote(pk.EmoteID, a.CurrentTick())
		return nil
	})
}

// EmotePacket builds a client emote. ServerSide is not set.
func EmotePacket(runtimeID uint64, emoteID string) *packet.Emote {
	if emoteID == "" {
		emoteID = DefaultEmoteID
	}
	return &packet.Emote{
		EntityRuntimeID: runtimeID,
		EmoteID:         emoteID,
		EmoteLength:     emoteLengthTicks,
		Flags:           0,
	}
}
