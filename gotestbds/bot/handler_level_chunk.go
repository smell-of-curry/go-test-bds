package bot

import (
	"bytes"

	"github.com/df-mc/dragonfly/server/block/cube"
	w "github.com/df-mc/dragonfly/server/world"
	"github.com/df-mc/dragonfly/server/world/chunk"
	"github.com/sandertv/gophertunnel/minecraft/protocol"
	"github.com/sandertv/gophertunnel/minecraft/protocol/packet"
	"github.com/smell-of-curry/go-test-bds/gotestbds/actor"
	"github.com/smell-of-curry/go-test-bds/gotestbds/world"
)

// LevelChunkHandler adds new chunk to Actor's world.
type LevelChunkHandler struct{}

// Handle ...
func (*LevelChunkHandler) Handle(p packet.Packet, b *Bot, a *actor.Actor) error {
	levelChunk := p.(*packet.LevelChunk)

	dim, ok := w.DimensionByID(int(levelChunk.Dimension))
	if !ok {
		dim = w.Overworld
	}

	dimensionRange := dim.Range()
	buf := bytes.NewBuffer(levelChunk.RawPayload)
	var blockEntities []chunk.BlockEntity

	// in case of an error we are just ignoring it, cause blocks are sent via SubChunk.
	ch, err := chunk.NetworkDecodeBuffer(b.airRid, buf, int(levelChunk.SubChunkCount), dimensionRange)
	if err == nil {
		// reading one byte for the border block count.
		_, _ = buf.ReadByte()
		blockEntities, err = decodeBlockEntities(buf)
	} else {
		ch = chunk.New(b.airRid, dim.Range())
	}

	a.World().AddChunk(w.ChunkPos(levelChunk.Position), world.NewColumn(ch, blockEntities))
	return b.requestSubchunks(dimensionRange, levelChunk.Dimension, levelChunk.Position)
}

// requestSubchunks requests subchunks from the server.
func (b *Bot) requestSubchunks(r cube.Range, dim int32, pos protocol.ChunkPos) error {
	var offsets []protocol.SubChunkOffset
	for y := 0; y < r.Max()-r.Min()+16; y += 16 {
		offsets = append(offsets, protocol.SubChunkOffset{0, int8(y), 0})
	}

	return b.Conn().WritePacket(&packet.SubChunkRequest{
		Dimension: dim,
		Position:  protocol.SubChunkPos{pos.X(), int32(r.Min() >> 4), pos.Z()},
		Offsets:   offsets,
	})
}
