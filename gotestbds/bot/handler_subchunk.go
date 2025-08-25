package bot

import (
	"bytes"
	"fmt"
	"maps"
	_ "unsafe"

	w "github.com/df-mc/dragonfly/server/world"
	"github.com/df-mc/dragonfly/server/world/chunk"
	"github.com/sandertv/gophertunnel/minecraft/protocol"
	"github.com/sandertv/gophertunnel/minecraft/protocol/packet"
	"github.com/smell-of-curry/go-test-bds/gotestbds/actor"
	"github.com/smell-of-curry/go-test-bds/gotestbds/internal"
	"github.com/smell-of-curry/go-test-bds/gotestbds/util"
	"github.com/smell-of-curry/go-test-bds/gotestbds/world"
)

// SubChunkHandler updates subchunk it the Actor's world.
type SubChunkHandler struct{}

// Handle ...
func (*SubChunkHandler) Handle(p packet.Packet, b *Bot, a *actor.Actor) error {
	subChunk := p.(*packet.SubChunk)
	pos := subChunk.Position
	dim, _ := w.DimensionByID(int(subChunk.Dimension))

	buf := internal.BufferPool.Get().(*bytes.Buffer)
	defer func() {
		buf.Reset()
		internal.BufferPool.Put(buf)
	}()

	var errors []error

	// Credit: https://github.com/oomph-ac/oomph/blob/3ad077131b68cd30a5fcab4daa835f3e134a49e7/player/component/acknowledgement/chunks.go#L65
	for _, entry := range subChunk.SubChunkEntries {
		if entry.Result != protocol.SubChunkResultSuccess {
			continue
		}

		chunkPos := w.ChunkPos{
			pos[0] + int32(entry.Offset[0]),
			pos[2] + int32(entry.Offset[2]),
		}

		c, ok := a.World().Chunk(chunkPos)
		if !ok {
			c.Chunk = chunk.New(b.airRid, dim.Range())
			a.World().AddChunk(chunkPos, c)
		}

		buf.Write(entry.RawPayload)

		var index byte
		decodedSC, err := decodeSubChunk(buf, c.Chunk, &index, chunk.NetworkEncoding)
		if err != nil {
			errors = append(errors, fmt.Errorf("error decoding subchunk, err: %w", err))
			continue
		}
		if buf.Len() != 0 {
			blockEntity, err := decodeBlockEntities(buf)
			if err == nil {
				maps.Copy(c.BlockEntities, world.NewColumn(c.Chunk, blockEntity).BlockEntities)
			}
		}
		c.Sub()[index] = decodedSC
	}
	return util.MultiError(errors...)
}
