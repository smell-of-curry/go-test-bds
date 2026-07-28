package world

import (
	"testing"

	"github.com/df-mc/dragonfly/server/block"
	"github.com/df-mc/dragonfly/server/block/cube"
	"github.com/df-mc/dragonfly/server/world"
	"github.com/df-mc/dragonfly/server/world/chunk"
)

// TestColumnLightPlatformAndTorch checks dragonfly LightArea fill on a solid
// platform: dark below, full sky above, and radial block light from a torch.
func TestColumnLightPlatformAndTorch(t *testing.T) {
	world.DefaultBlockRegistry.Finalize()

	w := NewWorld(false)
	pos := world.ChunkPos{0, 0}
	col := NewColumn(chunk.New(world.DefaultBlockRegistry, world.Overworld.Range()), nil)
	w.AddChunk(pos, col)

	// Solid stone floor at y=64 across the column.
	for x := 0; x < 16; x++ {
		for z := 0; z < 16; z++ {
			w.SetBlock(cube.Pos{x, 64, z}, block.Stone{})
		}
	}
	// Glowstone on top of the platform centre (emits 15).
	w.SetBlock(cube.Pos{8, 65, 8}, block.Glowstone{})

	w.EnsureColumnLight(pos)

	// Below the platform: sky light blocked.
	if got := col.SkyLight(8, 63, 8); got != 0 {
		t.Fatalf("sky below platform = %d, want 0", got)
	}
	// Above open air: full sky.
	if got := col.SkyLight(8, 80, 8); got != 15 {
		t.Fatalf("sky above platform = %d, want 15", got)
	}
	// Glowstone emits 15 at its own cell.
	if got := col.SubChunk(65).BlockLight(8, 65&0xf, 8); got != 15 {
		t.Fatalf("block light at glowstone = %d, want 15", got)
	}
	// One step away should still be lit, and fall off with distance.
	near := col.SubChunk(65).BlockLight(9, 65&0xf, 8)
	far := col.SubChunk(65).BlockLight(14, 65&0xf, 8)
	if near == 0 {
		t.Fatal("expected radial block light next to glowstone")
	}
	if far >= near {
		t.Fatalf("light should fall off: near=%d far=%d", near, far)
	}
}

// TestEnsureColumnLightDebounce ensures a second Ensure without a block edit
// does not bump Revision again.
func TestEnsureColumnLightDebounce(t *testing.T) {
	world.DefaultBlockRegistry.Finalize()

	w := NewWorld(false)
	pos := world.ChunkPos{0, 0}
	col := NewColumn(chunk.New(world.DefaultBlockRegistry, world.Overworld.Range()), nil)
	w.AddChunk(pos, col)
	w.SetBlock(cube.Pos{1, 70, 1}, block.Stone{})

	w.EnsureColumnLight(pos)
	rev := col.Revision
	w.EnsureColumnLight(pos)
	if col.Revision != rev {
		t.Fatalf("clean Ensure bumped Revision %d → %d", rev, col.Revision)
	}
}
