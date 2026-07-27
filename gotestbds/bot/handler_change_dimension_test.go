package bot

import (
	"testing"

	"github.com/df-mc/dragonfly/server/block"
	"github.com/df-mc/dragonfly/server/block/cube"
	"github.com/df-mc/dragonfly/server/world"
	"github.com/df-mc/dragonfly/server/world/chunk"
	"github.com/sandertv/gophertunnel/minecraft"
	"github.com/sandertv/gophertunnel/minecraft/protocol/login"
	"github.com/sandertv/gophertunnel/minecraft/protocol/packet"
	"github.com/smell-of-curry/go-test-bds/gotestbds/actor"
	"github.com/smell-of-curry/go-test-bds/gotestbds/entity"
	"github.com/smell-of-curry/go-test-bds/gotestbds/inventory"
	gw "github.com/smell-of-curry/go-test-bds/gotestbds/world"
)

type stubConn struct {
	game minecraft.GameData
}

func (c stubConn) IdentityData() login.IdentityData {
	return login.IdentityData{
		Identity:    "00000000-0000-0000-0000-000000000001",
		DisplayName: "test",
	}
}
func (stubConn) WritePacket(packet.Packet) error { return nil }
func (c stubConn) GameData() minecraft.GameData  { return c.game }

// recordingHandler captures HandleChangeDimension for the test.
type recordingHandler struct {
	actor.NopHandler
	from, to int32
	called   bool
}

func (h *recordingHandler) HandleChangeDimension(_ *actor.Actor, from, to int32) {
	h.called = true
	h.from = from
	h.to = to
}

// TestChangeDimensionHandlerFlushesAndSwitches covers the column flush and
// dimension switch a portal must do before the destination's LevelChunks land.
func TestChangeDimensionHandlerFlushesAndSwitches(t *testing.T) {
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

	w := a.World()
	w.AddChunk(
		world.ChunkPos{0, 0},
		gw.NewColumn(chunk.New(world.DefaultBlockRegistry, world.Overworld.Range()), nil),
	)
	w.SetBlock(cube.Pos{1, 70, 1}, block.Gold{})

	w.AddEntity(entity.CreateFromPacket(&packet.AddActor{
		EntityRuntimeID: 42,
		EntityUniqueID:  -4200,
		EntityType:      "minecraft:pig",
	}))

	h := &recordingHandler{}
	a.Handle(h)

	err := (&ChangeDimensionHandler{}).Handle(&packet.ChangeDimension{Dimension: 1}, nil, a)
	if err != nil {
		t.Fatal(err)
	}
	if a.Dimension() != 1 {
		t.Fatalf("actor dimension=%d, want 1", a.Dimension())
	}
	if _, ok := w.Chunk(world.ChunkPos{0, 0}); ok {
		t.Fatal("leaving dimension columns should be flushed")
	}
	if !h.called || h.from != 0 || h.to != 1 {
		t.Fatalf("HandleChangeDimension called=%v from=%d to=%d", h.called, h.from, h.to)
	}
	// The server never says goodbye to the entities left behind, so anything
	// but the bot itself has to go or the renderer draws the old dimension's
	// mobs standing in the new one.
	if _, ok := w.Entity(42); ok {
		t.Fatal("entities from the leaving dimension should be flushed")
	}
	if _, ok := w.EntityByUniqueID(-4200); ok {
		t.Fatal("flushed entity still in the unique-ID index")
	}
	if _, ok := w.Entity(a.RuntimeID()); !ok {
		t.Fatal("the bot's own entity must survive a dimension change")
	}
}
