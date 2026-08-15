package world

import (
	"testing"

	"github.com/df-mc/dragonfly/server/block"
	"github.com/df-mc/dragonfly/server/world"
	"github.com/df-mc/dragonfly/server/world/chunk"
)

// TestColumnLightHashedIDs mimics the real-server pipeline: hashed network IDs
// stored in the palette, then EnsureColumnLight. Regression for the black-world
// bug — Fill was run over a 3×3 area, but dragonfly's Fill only heightmap-seeds
// sky light for c[0], so the centre column's surface sub-chunk stayed dark.
func TestColumnLightHashedIDs(t *testing.T) {
	world.DefaultBlockRegistry.Finalize()

	stone := world.DefaultBlockRegistry.BlockRuntimeID(block.Stone{})
	hash, ok := world.DefaultBlockRegistry.RuntimeIDToHash(stone)
	if !ok {
		t.Fatal("no hash for stone")
	}

	w := NewWorld(true) // hashed IDs like production BDS
	pos := world.ChunkPos{0, 0}
	col := NewColumn(chunk.New(world.DefaultBlockRegistry, world.Overworld.Range()), nil)
	w.AddChunk(pos, col)

	// Solid stone floor at y=64 stored as HASHES (as the network layer does).
	for x := uint8(0); x < 16; x++ {
		for z := uint8(0); z < 16; z++ {
			col.SetBlock(x, 64, z, 0, hash)
		}
	}

	if col.LightFilled() {
		t.Fatal("column reports light filled before fill ran")
	}
	if !w.EnsureColumnLight(pos) {
		t.Fatal("EnsureColumnLight reported no work for a dirty column")
	}
	if !col.LightFilled() {
		t.Fatal("column reports light unfilled after fill")
	}

	// The surface cell just above the platform is inside the sub-chunk that
	// CONTAINS the platform — the exact cell the 3×3 Fill bug left at 0.
	if got := col.SkyLight(8, 65, 8); got != 15 {
		t.Fatalf("sky just above platform = %d, want 15", got)
	}
	if got := col.SkyLight(8, 63, 8); got != 0 {
		t.Fatalf("sky below platform = %d, want 0", got)
	}
	// Palette hashes must be restored after the fill's local-ID remap.
	if got := col.Chunk.Block(8, 64, 8, 0); got != hash {
		t.Fatalf("palette not restored: block = %d, want hash %d", got, hash)
	}
}

// TestColumnLightSpreadRing checks Spread runs only once the full 3×3 ring is
// complete and filled, and that block light then crosses the chunk border.
func TestColumnLightSpreadRing(t *testing.T) {
	world.DefaultBlockRegistry.Finalize()

	w := NewWorld(false)
	center := world.ChunkPos{0, 0}
	for dz := int32(-1); dz <= 1; dz++ {
		for dx := int32(-1); dx <= 1; dx++ {
			w.AddChunk(world.ChunkPos{dx, dz}, NewColumn(chunk.New(world.DefaultBlockRegistry, world.Overworld.Range()), nil))
		}
	}
	col, _ := w.Chunk(center)
	east, _ := w.Chunk(world.ChunkPos{1, 0})

	// Glowstone at the centre column's east edge; its light should cross into
	// the east neighbour once Spread runs.
	glow := world.DefaultBlockRegistry.BlockRuntimeID(block.Glowstone{})
	col.SetBlock(15, 64, 8, 0, glow)

	// Fill every column, then Ensure the centre again so the ring is filled
	// and Spread fires.
	for dz := int32(-1); dz <= 1; dz++ {
		for dx := int32(-1); dx <= 1; dx++ {
			w.EnsureColumnLight(world.ChunkPos{dx, dz})
		}
	}
	w.EnsureColumnLight(center)

	if got := east.SubChunk(64).BlockLight(0, 64&0xf, 8); got == 0 {
		t.Fatal("block light did not spread across the chunk border")
	}
}
