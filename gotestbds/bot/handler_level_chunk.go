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
	subChunks, requestMode := subChunkCount(levelChunk, dimensionRange)

	ch := chunk.New(blockRegistry, dimensionRange)
	var blockEntities []chunk.BlockEntity
	if !requestMode {
		buf := bytes.NewBuffer(levelChunk.RawPayload)
		// in case of an error we are just ignoring it, cause blocks are sent via SubChunk.
		decoded, err := chunk.NetworkDecodeBuffer(blockRegistry, buf, subChunks, dimensionRange)
		if err == nil {
			ch = decoded
			// reading one byte for the border block count.
			_, _ = buf.ReadByte()
			blockEntities, _ = decodeBlockEntities(buf)
		}
	}

	col := world.NewColumn(ch, blockEntities)
	if requestMode {
		// SubChunkCount was a request-mode sentinel: the payload held biomes,
		// not blocks. The column stays empty until every requested sub-chunk
		// arrives — marking it complete here would show holes as solid air.
		col.ExpectSubChunks(subChunks)
	}
	a.World().AddChunk(w.ChunkPos(levelChunk.Position), col)
	if !requestMode {
		return nil
	}
	return b.requestSubchunks(dimensionRange, levelChunk.Dimension, levelChunk.Position, subChunks)
}

// subChunkCount reads how many sub-chunks a LevelChunk carries.
//
// SubChunkCount doubles as a sentinel: the two request modes ask the client to
// pull the blocks itself with SubChunkRequest, and the payload then holds only
// biomes. Feeding those sentinels to a block decoder reads the biome bytes as
// sub-chunk headers, which is where "unknown sub chunk version 89" comes from.
//
// @param levelChunk The packet to read.
// @param r The vertical range of the chunk's dimension.
// @returns the number of sub-chunks to expect, and whether the server expects a
// SubChunkRequest instead of having sent the blocks inline.
func subChunkCount(levelChunk *packet.LevelChunk, r cube.Range) (int, bool) {
	max := (r.Max() - r.Min() + 1) >> 4
	switch levelChunk.SubChunkCount {
	case protocol.SubChunkRequestModeLimited:
		// HighestSubChunk indexes from the bottom of the dimension, so everything
		// above it is air and not worth asking for.
		return min(int(levelChunk.HighestSubChunk)+1, max), true
	case protocol.SubChunkRequestModeLimitless:
		return max, true
	}
	return min(int(levelChunk.SubChunkCount), max), false
}

// requestSubchunks requests subchunks from the server.
//
// @param r The vertical range of the chunk's dimension.
// @param dim The dimension ID the chunk belongs to.
// @param pos The chunk being requested.
// @param count How many sub-chunks to ask for, counted up from the bottom.
// @returns any error writing the request.
func (b *Bot) requestSubchunks(r cube.Range, dim int32, pos protocol.ChunkPos, count int) error {
	// Offsets are in sub-chunks relative to Position, not in blocks: the old
	// `y += 16` walk asked for sub-chunk 16, 32, … past the top of the world
	// (and overflowed int8 doing it), so the server rejected nearly every entry
	// and the bot's world stayed empty.
	offsets := make([]protocol.SubChunkOffset, 0, count)
	for y := range count {
		offsets = append(offsets, protocol.SubChunkOffset{0, int8(y), 0})
	}

	return b.Conn().WritePacket(&packet.SubChunkRequest{
		Dimension: dim,
		Position:  protocol.SubChunkPos{pos.X(), int32(r.Min() >> 4), pos.Z()},
		Offsets:   offsets,
	})
}
