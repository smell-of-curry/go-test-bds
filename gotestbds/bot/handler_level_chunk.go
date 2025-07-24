package bot

import (
	"github.com/df-mc/dragonfly/server/world"
	"github.com/df-mc/dragonfly/server/world/chunk"
	"github.com/sandertv/gophertunnel/minecraft/protocol"
	"github.com/sandertv/gophertunnel/minecraft/protocol/packet"
	"github.com/smell-of-curry/go-test-bds/gotestbds/actor"
)

// LevelChunkHandler adds new chunk to Actor's world.
type LevelChunkHandler struct{}

// Handle ...
func (*LevelChunkHandler) Handle(p packet.Packet, b *Bot, a *actor.Actor) {
	levelChunk := p.(*packet.LevelChunk)

	dim, ok := world.DimensionByID(int(levelChunk.Dimension))
	if !ok {
		dim = world.Overworld
	}

	dimensionRange := dim.Range()

	ch, err := chunk.NetworkDecode(airRid, levelChunk.RawPayload, int(levelChunk.SubChunkCount), dimensionRange)
	if err != nil {
		ch = chunk.New(airRid, dim.Range())
	}

	a.World().AddChunk(world.ChunkPos(levelChunk.Position), ch)

	var offsets []protocol.SubChunkOffset
	for y := 0; y < dimensionRange.Max()-dimensionRange.Min()+16; y += 16 {
		offsets = append(offsets, protocol.SubChunkOffset{0, int8(y), 0})
	}

	b.Conn().WritePacket(&packet.SubChunkRequest{
		Dimension: levelChunk.Dimension,
		Position:  protocol.SubChunkPos{levelChunk.Position.X(), int32(dimensionRange.Min() >> 4), levelChunk.Position.Z()},
		Offsets:   offsets,
	})
}

func init() {
	rid, ok := chunk.StateToRuntimeID("minecraft:air", nil)
	if !ok {
		panic("cannot find air runtime ID")
	}
	airRid = rid
}

var airRid uint32
