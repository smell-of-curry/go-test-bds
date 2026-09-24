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
	buf := bytes.NewBuffer(levelChunk.RawPayload)
	if !requestMode {
		// in case of an error we are just ignoring it, cause blocks are sent via SubChunk.
		decoded, err := chunk.NetworkDecodeBuffer(blockRegistry, buf, subChunks, dimensionRange)
		if err == nil {
			ch = decoded
			// reading one byte for the border block count.
			_, _ = buf.ReadByte()
			blockEntities, _ = decodeBlockEntities(buf)
		}
	} else if len(levelChunk.RawPayload) > 0 {
		// Request-mode payload is biomes only (no block sub-chunks). count=0
		// skips the block loop and still runs dragonfly's biome decode.
		if decoded, err := chunk.NetworkDecodeBuffer(blockRegistry, buf, 0, dimensionRange); err == nil {
			ch = decoded
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
// As of protocol 1.26.50, request mode is SubChunkCount=0 plus an optional
// SubChunkLimit (replacing the old MaxUint32 sentinels + HighestSubChunk).
// The payload then holds only biomes. Feeding a request-mode packet to a block
// decoder reads the biome bytes as sub-chunk headers, which is where
// "unknown sub chunk version 89" comes from.
//
// @param levelChunk The packet to read.
// @param r The vertical range of the chunk's dimension.
// @returns the number of sub-chunks to expect, and whether the server expects a
// SubChunkRequest instead of having sent the blocks inline.
func subChunkCount(levelChunk *packet.LevelChunk, r cube.Range) (int, bool) {
	max := (r.Max() - r.Min() + 1) >> 4
	if limit, ok := levelChunk.SubChunkLimit.Value(); ok {
		// -1 = limitless (request the full dimension height).
		if limit < 0 {
			return max, true
		}
		// SubChunkLimit is a count from the bottom (HighestFilledSubChunk),
		// not a 0-based index.
		return min(int(limit), max), true
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
