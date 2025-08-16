package bot

import (
	"bytes"
	"fmt"
	_ "unsafe"

	"github.com/df-mc/dragonfly/server/block/cube"
	"github.com/df-mc/dragonfly/server/world/chunk"
	"github.com/sandertv/gophertunnel/minecraft/nbt"
)

//go:linkname decodeSubChunk github.com/df-mc/dragonfly/server/world/chunk.decodeSubChunk
func decodeSubChunk(buf *bytes.Buffer, c *chunk.Chunk, index *byte, e chunk.Encoding) (*chunk.SubChunk, error)

func init() {
	rid, ok := chunk.StateToRuntimeID("minecraft:air", nil)
	if !ok {
		panic("cannot find air runtime ID")
	}
	airRid = rid
}

var airRid uint32

// decodeBlockEntities decodes blockEntities from buf.
func decodeBlockEntities(buf *bytes.Buffer) ([]chunk.BlockEntity, error) {
	var blockEntities []chunk.BlockEntity

	dec := nbt.NewDecoderWithEncoding(buf, nbt.LittleEndian)

	for buf.Len() != 0 {
		be := chunk.BlockEntity{Data: make(map[string]any)}
		if err := dec.Decode(&be.Data); err != nil {
			return blockEntities, fmt.Errorf("decode nbt: %w", err)
		}
		be.Pos = blockPosFromNBT(be.Data)
		blockEntities = append(blockEntities, be)
	}
	return blockEntities, nil
}

// blockPosFromNBT returns block pos from nbt.
func blockPosFromNBT(data map[string]any) cube.Pos {
	x, _ := data["x"].(int32)
	y, _ := data["y"].(int32)
	z, _ := data["z"].(int32)
	return cube.Pos{int(x), int(y), int(z)}
}
