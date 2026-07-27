package actor

import (
	"testing"

	"github.com/df-mc/dragonfly/server/world"
	"github.com/df-mc/dragonfly/server/world/chunk"
	"github.com/go-gl/mathgl/mgl64"
	botworld "github.com/smell-of-curry/go-test-bds/gotestbds/world"
)

// TestChunkLoadedAt covers the guard that keeps physics from running against a
// chunk that has not arrived. Without it a bot spawns, reads the missing world
// as air, and falls out of it before its first chunk is received.
func TestChunkLoadedAt(t *testing.T) {
	w := botworld.NewWorld(false)
	pos := mgl64.Vec3{66.5, 78.8, 0.5}

	if chunkLoadedAt(w, pos) {
		t.Fatal("an empty world should report no loaded chunk")
	}

	world.DefaultBlockRegistry.Finalize()
	w.AddChunk(
		world.ChunkPos{4, 0},
		botworld.NewColumn(
			chunk.New(world.DefaultBlockRegistry, world.Overworld.Range()),
			nil,
		),
	)

	if !chunkLoadedAt(w, pos) {
		t.Errorf("position %v should resolve to the chunk added at 4, 0", pos)
	}
	if chunkLoadedAt(w, mgl64.Vec3{-500, 78, 0}) {
		t.Error("a position outside the added chunk should report unloaded")
	}
}
