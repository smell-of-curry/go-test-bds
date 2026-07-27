package world

import (
	"testing"

	"github.com/df-mc/dragonfly/server/block"
	"github.com/df-mc/dragonfly/server/block/cube"
	"github.com/df-mc/dragonfly/server/world"
	"github.com/df-mc/dragonfly/server/world/chunk"
)

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
