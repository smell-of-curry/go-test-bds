package bot

import (
	"testing"

	"github.com/df-mc/dragonfly/server/world"
	"github.com/df-mc/dragonfly/server/world/chunk"
	"github.com/sandertv/gophertunnel/minecraft"
	"github.com/smell-of-curry/go-test-bds/gotestbds/actor"
	"github.com/smell-of-curry/go-test-bds/gotestbds/inventory"
	gw "github.com/smell-of-curry/go-test-bds/gotestbds/world"
)

// TestChunkHealthStuckRetriesOnlyUnansweredColumns covers BDS dropping a
// SubChunkRequest: a column with no sub-chunk across a whole window is asked
// for again, a fresh one is not, and a partial one is left alone.
func TestChunkHealthStuckRetriesOnlyUnansweredColumns(t *testing.T) {
	world.DefaultBlockRegistry.Finalize()
	a := actor.Config{
		Conn:      stubConn{game: minecraft.GameData{EntityRuntimeID: 1, EntityUniqueID: 1, ChunkRadius: 8}},
		Inventory: inventory.NewHandle(36, 0, nil),
		Offhand:   inventory.NewHandle(1, 0, nil),
		Armour:    inventory.NewArmour(nil),
		Ui:        inventory.NewHandle(54, 0, nil),
	}.New()
	add := func(pos world.ChunkPos, expect int) *gw.Column {
		col := gw.NewColumn(chunk.New(world.DefaultBlockRegistry, world.Overworld.Range()), nil)
		col.ExpectSubChunks(expect)
		a.World().AddChunk(pos, col)
		return col
	}
	add(world.ChunkPos{0, 0}, 2)
	partial := add(world.ChunkPos{1, 0}, 2)

	var h chunkHealth
	if got := h.stuck(a); len(got) != 0 {
		t.Fatalf("first window retried %v, want none", got)
	}
	partial.ReceiveSubChunk()
	add(world.ChunkPos{2, 0}, 2)

	got := h.stuck(a)
	if len(got) != 1 || got[0] != (world.ChunkPos{0, 0}) {
		t.Fatalf("second window retried %v, want only [0 0]", got)
	}
}
