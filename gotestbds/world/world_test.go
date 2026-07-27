package world

import (
	"testing"

	"github.com/df-mc/dragonfly/server/block"
	"github.com/df-mc/dragonfly/server/block/cube"
	"github.com/df-mc/dragonfly/server/item"
	"github.com/df-mc/dragonfly/server/world"
	"github.com/df-mc/dragonfly/server/world/chunk"
	"github.com/go-gl/mathgl/mgl64"
	"github.com/smell-of-curry/go-test-bds/gotestbds/entity/attributes"
	"github.com/smell-of-curry/go-test-bds/gotestbds/entity/metadata"
	"github.com/smell-of-curry/go-test-bds/gotestbds/inventory"
)

// ridEnt is a minimal Entity for index tests. The real entity package imports
// world, so world_test cannot use it without an import cycle.
type ridEnt struct {
	rid uint64
	uid int64
}

func (e *ridEnt) Position() mgl64.Vec3                      { return mgl64.Vec3{} }
func (e *ridEnt) Rotation() cube.Rotation                   { return cube.Rotation{} }
func (e *ridEnt) Velocity() mgl64.Vec3                      { return mgl64.Vec3{} }
func (e *ridEnt) SetVelocity(mgl64.Vec3)                    {}
func (e *ridEnt) State() *metadata.State                    { return &metadata.State{} }
func (e *ridEnt) Attributes() *attributes.Values            { return &attributes.Values{} }
func (e *ridEnt) Armour() *inventory.Armour                 { return inventory.NewArmour(nil) }
func (e *ridEnt) HeldItems() (item.Stack, item.Stack)       { return item.Stack{}, item.Stack{} }
func (e *ridEnt) SetHeldItems(item.Stack, item.Stack) error { return nil }
func (e *ridEnt) RuntimeID() uint64                         { return e.rid }
func (e *ridEnt) UniqueID() int64                           { return e.uid }
func (e *ridEnt) Move(mgl64.Vec3, cube.Rotation)            {}
func (e *ridEnt) Type() string                              { return "minecraft:pig" }

// TestUndecodableBlockIsSolid covers the floor a bot stands on when the server
// runs an addon: those blocks are not in this registry, and reading them as air
// drops the bot out of the world.
func TestUndecodableBlockIsSolid(t *testing.T) {
	world.DefaultBlockRegistry.Finalize()

	w := NewWorld(false)
	w.AddChunk(
		world.ChunkPos{0, 0},
		NewColumn(chunk.New(world.DefaultBlockRegistry, world.Overworld.Range()), nil),
	)

	pos := cube.Pos{1, 70, 1}
	// A runtime ID far past the end of the palette is what a custom block looks
	// like to a bot that does not know the server's blocks.
	w.SetBlockRuntimeID(pos, 1<<30, 0)

	b := w.Block(pos)
	if _, ok := b.(UnknownBlock); !ok {
		t.Fatalf("expected an UnknownBlock, got %T", b)
	}
	if len(b.Model().BBox(pos, nil)) == 0 {
		t.Error("an unknown block must collide, or a bot falls through it")
	}

	name, _ := b.EncodeBlock()
	if name != "gotestbds:unknown" {
		t.Errorf("unknown block should name itself, got %q", name)
	}
}

// TestHashedRuntimeIDsDecode covers a server running with
// block-network-ids-are-hashes, which is the BDS default: a palette entry is a
// hash of the block state rather than a runtime ID, and reading it as a runtime
// ID names every block the bot sees "unknown".
func TestHashedRuntimeIDsDecode(t *testing.T) {
	world.DefaultBlockRegistry.Finalize()

	gold := world.BlockRuntimeID(block.Gold{})
	hash, ok := world.DefaultBlockRegistry.RuntimeIDToHash(gold)
	if !ok {
		t.Fatal("gold block should hash in the vanilla registry")
	}

	pos := cube.Pos{2, 70, 2}
	for _, test := range []struct {
		name    string
		hashed  bool
		written uint32
	}{
		{name: "hashed", hashed: true, written: hash},
		{name: "unhashed", hashed: false, written: gold},
	} {
		t.Run(test.name, func(t *testing.T) {
			w := NewWorld(test.hashed)
			w.AddChunk(
				world.ChunkPos{0, 0},
				NewColumn(chunk.New(world.DefaultBlockRegistry, world.Overworld.Range()), nil),
			)
			w.SetBlockRuntimeID(pos, test.written, 0)

			if _, ok := w.Block(pos).(block.Gold); !ok {
				t.Fatalf("expected a gold block, got %T", w.Block(pos))
			}
		})
	}
}

// TestRemoveEntityByUniqueID covers the ghost entities a renderer would keep
// drawing: RemoveActor identifies by unique ID, which is not always equal to
// the runtime ID the entity map is keyed on.
func TestRemoveEntityByUniqueID(t *testing.T) {
	w := NewWorld(false)
	ent := &ridEnt{rid: 42, uid: 99}
	w.AddEntity(ent)

	if _, ok := w.Entity(42); !ok {
		t.Fatal("entity should be indexed by runtime ID")
	}
	if got, ok := w.EntityByUniqueID(99); !ok || got.RuntimeID() != 42 {
		t.Fatal("entity should be indexed by unique ID")
	}

	if !w.RemoveEntityByUniqueID(99) {
		t.Fatal("RemoveEntityByUniqueID should remove when unique ID is tracked")
	}
	if _, ok := w.Entity(42); ok {
		t.Error("runtime ID index still holds removed entity")
	}
	if _, ok := w.EntityByUniqueID(99); ok {
		t.Error("unique ID index still holds removed entity")
	}
	if w.RemoveEntityByUniqueID(99) {
		t.Error("second remove should report nothing removed")
	}
}

// TestDimensionIsolation covers overworld and a custom dimension sharing one
// ChunkPos keyspace when columns were stored in a single map.
func TestDimensionIsolation(t *testing.T) {
	world.DefaultBlockRegistry.Finalize()

	w := NewWorld(false)
	pos := cube.Pos{1, 70, 1}
	chunkPos := world.ChunkPos{0, 0}

	w.SetDimension(0)
	w.AddChunk(chunkPos, NewColumn(chunk.New(world.DefaultBlockRegistry, world.Overworld.Range()), nil))
	w.SetBlock(pos, block.Gold{})

	w.SetDimension(1)
	w.AddChunk(chunkPos, NewColumn(chunk.New(world.DefaultBlockRegistry, world.Nether.Range()), nil))
	w.SetBlock(pos, block.Dirt{})

	if _, ok := w.Block(pos).(block.Dirt); !ok {
		t.Fatalf("dimension 1 should hold dirt, got %T", w.Block(pos))
	}

	w.SetDimension(0)
	if _, ok := w.Block(pos).(block.Gold); !ok {
		t.Fatalf("dimension 0 should still hold gold after switch, got %T", w.Block(pos))
	}
}

// TestBlockAtUnloadedVersusAir covers the renderer needing to tell "column not
// received" apart from "loaded air block". Block() stays air-for-unloaded so
// physics is unchanged.
func TestBlockAtUnloadedVersusAir(t *testing.T) {
	world.DefaultBlockRegistry.Finalize()

	w := NewWorld(false)
	pos := cube.Pos{1, 70, 1}

	if _, ok := w.BlockAt(pos); ok {
		t.Fatal("BlockAt should report not-ok for an unloaded column")
	}
	if w.Loaded(pos) {
		t.Fatal("Loaded should be false for an unloaded column")
	}
	if _, ok := w.Block(pos).(block.Air); !ok {
		t.Fatalf("Block must keep returning air for unloaded columns, got %T", w.Block(pos))
	}

	w.AddChunk(
		world.ChunkPos{0, 0},
		NewColumn(chunk.New(world.DefaultBlockRegistry, world.Overworld.Range()), nil),
	)
	// A freshly decoded column is air-filled; that is loaded air, not "missing".
	b, ok := w.BlockAt(pos)
	if !ok {
		t.Fatal("BlockAt should report ok for a loaded column")
	}
	if _, isAir := b.(block.Air); !isAir {
		t.Fatalf("expected air in an empty loaded column, got %T", b)
	}
	if !w.Loaded(pos) {
		t.Fatal("Loaded should be true for a loaded in-range position")
	}
}

// TestColumnReceiptState covers requested -> partial -> complete as sub-chunks
// arrive for a request-mode LevelChunk.
func TestColumnReceiptState(t *testing.T) {
	world.DefaultBlockRegistry.Finalize()

	col := NewColumn(chunk.New(world.DefaultBlockRegistry, world.Overworld.Range()), nil)
	if col.State != ColumnComplete {
		t.Fatalf("inline column should start complete, got %s", col.State)
	}

	col.ExpectSubChunks(3)
	if col.State != ColumnRequested || col.PendingSubChunks() != 3 {
		t.Fatalf("after ExpectSubChunks(3): state=%s pending=%d", col.State, col.PendingSubChunks())
	}
	if col.State.String() != "requested" {
		t.Fatalf("String()=%q", col.State.String())
	}

	col.ReceiveSubChunk()
	if col.State != ColumnPartial || col.PendingSubChunks() != 2 {
		t.Fatalf("after first ReceiveSubChunk: state=%s pending=%d", col.State, col.PendingSubChunks())
	}
	if col.State.String() != "partial" {
		t.Fatalf("String()=%q", col.State.String())
	}

	col.ReceiveSubChunk()
	col.ReceiveSubChunk()
	if col.State != ColumnComplete || col.PendingSubChunks() != 0 {
		t.Fatalf("after all sub-chunks: state=%s pending=%d", col.State, col.PendingSubChunks())
	}
	if col.State.String() != "complete" {
		t.Fatalf("String()=%q", col.State.String())
	}
}
