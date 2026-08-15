package bot

import (
	"testing"

	"github.com/df-mc/dragonfly/server/world"
	"github.com/df-mc/dragonfly/server/world/chunk"
	"github.com/sandertv/gophertunnel/minecraft"
	"github.com/sandertv/gophertunnel/minecraft/protocol"
	"github.com/sandertv/gophertunnel/minecraft/protocol/packet"
	"github.com/smell-of-curry/go-test-bds/gotestbds/actor"
	"github.com/smell-of-curry/go-test-bds/gotestbds/inventory"
	gw "github.com/smell-of-curry/go-test-bds/gotestbds/world"
)

// TestSubChunkHandlerAllAirCompletesColumn covers the state a column above
// ground level always ends in: the sub-chunks holding sky come back as all-air
// with no payload, and a column that never retires those requests stays partial
// for the rest of the session — which the viewer draws as a hole.
func TestSubChunkHandlerAllAirCompletesColumn(t *testing.T) {
	world.DefaultBlockRegistry.Finalize()

	a := actor.Config{
		Conn: stubConn{game: minecraft.GameData{
			EntityRuntimeID: 1,
			EntityUniqueID:  1,
			Dimension:       0,
			ChunkRadius:     8,
		}},
		Inventory: inventory.NewHandle(36, 0, nil),
		Offhand:   inventory.NewHandle(1, 0, nil),
		Armour:    inventory.NewArmour(nil),
		Ui:        inventory.NewHandle(54, 0, nil),
	}.New()

	col := gw.NewColumn(
		chunk.New(world.DefaultBlockRegistry, world.Overworld.Range()),
		nil,
	)
	col.ExpectSubChunks(2)
	a.World().AddChunk(world.ChunkPos{0, 0}, col)

	entries := []protocol.SubChunkEntry{
		{Offset: [3]int8{0, 0, 0}, Result: protocol.SubChunkResultSuccessAllAir},
		{Offset: [3]int8{0, 1, 0}, Result: protocol.SubChunkResultSuccessAllAir},
	}
	err := (&SubChunkHandler{}).Handle(
		&packet.SubChunk{Dimension: 0, SubChunkEntries: entries},
		nil,
		a,
	)
	if err != nil {
		t.Fatal(err)
	}

	if got := col.PendingSubChunks(); got != 0 {
		t.Fatalf("pending sub-chunks=%d, want 0", got)
	}
	if col.State != gw.ColumnComplete {
		t.Fatalf("column state=%s, want complete", col.State)
	}
}

// TestSubChunkHandlerFailureLeavesColumnPending covers the other half: a result
// that is not an answer must not retire a request, so the column stays partial
// and the viewer keeps drawing the missing data as missing.
func TestSubChunkHandlerFailureLeavesColumnPending(t *testing.T) {
	world.DefaultBlockRegistry.Finalize()

	a := actor.Config{
		Conn: stubConn{game: minecraft.GameData{
			EntityRuntimeID: 1,
			EntityUniqueID:  1,
			Dimension:       0,
			ChunkRadius:     8,
		}},
		Inventory: inventory.NewHandle(36, 0, nil),
		Offhand:   inventory.NewHandle(1, 0, nil),
		Armour:    inventory.NewArmour(nil),
		Ui:        inventory.NewHandle(54, 0, nil),
	}.New()

	col := gw.NewColumn(
		chunk.New(world.DefaultBlockRegistry, world.Overworld.Range()),
		nil,
	)
	col.ExpectSubChunks(1)
	a.World().AddChunk(world.ChunkPos{0, 0}, col)

	err := (&SubChunkHandler{}).Handle(
		&packet.SubChunk{Dimension: 0, SubChunkEntries: []protocol.SubChunkEntry{
			{Offset: [3]int8{0, 0, 0}, Result: protocol.SubChunkResultChunkNotFound},
		}},
		nil,
		a,
	)
	if err != nil {
		t.Fatal(err)
	}

	if got := col.PendingSubChunks(); got != 1 {
		t.Fatalf("pending sub-chunks=%d, want 1", got)
	}
	if col.State != gw.ColumnRequested {
		t.Fatalf("column state=%s, want requested", col.State)
	}
}
