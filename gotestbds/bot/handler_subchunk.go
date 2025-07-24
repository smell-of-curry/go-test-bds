package bot

import (
	"bytes"
	"github.com/df-mc/dragonfly/server/world"
	"github.com/df-mc/dragonfly/server/world/chunk"
	"github.com/sandertv/gophertunnel/minecraft/protocol"
	"github.com/sandertv/gophertunnel/minecraft/protocol/packet"
	"github.com/smell-of-curry/go-test-bds/gotestbds/actor"
	"github.com/smell-of-curry/go-test-bds/gotestbds/internal"
	_ "unsafe"
)

// SubChunkHandler updates subchunk it the Actor's world.
type SubChunkHandler struct{}

// Handle ...
func (s SubChunkHandler) Handle(p packet.Packet, b *Bot, a *actor.Actor) {
	subChunk := p.(*packet.SubChunk)
	pos := subChunk.Position
	dim, _ := world.DimensionByID(int(subChunk.Dimension))

	w := a.World()

	buf := internal.BufferPool.Get().(*bytes.Buffer)
	defer func() {
		buf.Reset()
		internal.BufferPool.Put(buf)
	}()

	// Credit: https://github.com/oomph-ac/oomph/blob/3ad077131b68cd30a5fcab4daa835f3e134a49e7/player/component/acknowledgement/chunks.go#L65
	for _, entry := range subChunk.SubChunkEntries {
		if entry.Result != protocol.SubChunkResultSuccess {
			continue
		}

		chunkPos := world.ChunkPos{
			pos[0] + int32(entry.Offset[0]),
			pos[2] + int32(entry.Offset[2]),
		}

		c, ok := w.Chunk(chunkPos)
		if !ok {
			c = chunk.New(airRid, dim.Range())
			w.AddChunk(chunkPos, c)
		}

		var index byte
		decodedSC, err := decodeSubChunk(buf, c, &index, chunk.NetworkEncoding)
		if err != nil {
			b.logger.Error("error decoding subchunk", "error", err)
			continue
		}
		c.Sub()[index] = decodedSC
	}
}

//go:linkname decodeSubChunk github.com/df-mc/dragonfly/server/world/chunk.decodeSubChunk
func decodeSubChunk(buf *bytes.Buffer, c *chunk.Chunk, index *byte, e chunk.Encoding) (*chunk.SubChunk, error)
