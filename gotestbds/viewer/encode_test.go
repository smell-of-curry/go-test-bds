package viewer

import (
	"encoding/base64"
	"encoding/binary"
	"encoding/json"
	"testing"

	"github.com/df-mc/dragonfly/server/block"
	"github.com/df-mc/dragonfly/server/block/cube"
	dfworld "github.com/df-mc/dragonfly/server/world"
	"github.com/df-mc/dragonfly/server/world/chunk"
	"github.com/go-gl/mathgl/mgl64"
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
	name string
}

func (c stubConn) IdentityData() login.IdentityData {
	return login.IdentityData{
		Identity:    "00000000-0000-0000-0000-000000000001",
		DisplayName: c.name,
	}
}
func (stubConn) WritePacket(packet.Packet) error { return nil }
func (c stubConn) GameData() minecraft.GameData  { return c.game }

func testActor(t testing.TB, name string) *actor.Actor {
	t.Helper()
	dfworld.DefaultBlockRegistry.Finalize()
	a := actor.Config{
		Conn: stubConn{
			name: name,
			game: minecraft.GameData{
				EntityRuntimeID: 1,
				EntityUniqueID:  1,
				Dimension:       0,
				ChunkRadius:     8,
			},
		},
		Inventory: inventory.NewHandle(36, 0, nil),
		Offhand:   inventory.NewHandle(1, 0, nil),
		Armour:    inventory.NewArmour(nil),
		Ui:        inventory.NewHandle(54, 0, nil),
	}.New()
	return a
}

func addColumn(w *gw.World, pos dfworld.ChunkPos) *gw.Column {
	col := gw.NewColumn(chunk.New(dfworld.DefaultBlockRegistry, dfworld.Overworld.Range()), nil)
	w.AddChunk(pos, col)
	return col
}

// clientModel is a plain map-based reconstruction of the wire state.
type clientModel struct {
	world    World
	columns  map[[2]int32]Column
	entities map[uint64]Entity
	blocks   map[[4]int]Block // x,y,z,layer
}

func newClientModel() *clientModel {
	return &clientModel{
		columns:  make(map[[2]int32]Column),
		entities: make(map[uint64]Entity),
		blocks:   make(map[[4]int]Block),
	}
}

func (m *clientModel) applyKeyframe(kf Keyframe) {
	m.world = kf.World
	m.columns = make(map[[2]int32]Column)
	m.entities = make(map[uint64]Entity)
	m.blocks = make(map[[4]int]Block)
	for _, c := range kf.Columns {
		m.columns[[2]int32{c.X, c.Z}] = c
		m.ingestColumn(c)
	}
	for _, e := range kf.Entities {
		m.entities[e.RID] = e
	}
}

func (m *clientModel) applyDelta(d Delta) {
	if d.World != nil {
		m.world = *d.World
		m.columns = make(map[[2]int32]Column)
		m.entities = make(map[uint64]Entity)
		m.blocks = make(map[[4]int]Block)
	}
	for _, key := range d.ColumnsRemoved {
		delete(m.columns, key)
		baseX, baseZ := int(key[0])*16, int(key[1])*16
		for k := range m.blocks {
			if k[0] >= baseX && k[0] < baseX+16 && k[2] >= baseZ && k[2] < baseZ+16 {
				delete(m.blocks, k)
			}
		}
	}
	for _, c := range d.ColumnsAdded {
		m.columns[[2]int32{c.X, c.Z}] = c
		m.ingestColumn(c)
	}
	for _, st := range d.ColumnsState {
		key := [2]int32{st.X, st.Z}
		c := m.columns[key]
		c.State = st.State
		m.columns[key] = c
	}
	for _, b := range d.Blocks {
		m.blocks[[4]int{b.Pos[0], b.Pos[1], b.Pos[2], b.Layer}] = b.Block
	}
	for _, e := range d.EntitiesAdded {
		m.entities[e.RID] = e
	}
	for _, e := range d.EntitiesUpdated {
		m.entities[e.RID] = e
	}
	for _, rid := range d.EntitiesRemoved {
		delete(m.entities, rid)
	}
}

func (m *clientModel) ingestColumn(c Column) {
	baseX, baseZ := int(c.X)*16, int(c.Z)*16
	for _, sec := range c.Sections {
		apply := func(b64 string, layer int) {
			if b64 == "" {
				return
			}
			raw, err := base64.StdEncoding.DecodeString(b64)
			if err != nil {
				return
			}
			for i := 0; i < 4096; i++ {
				idx := binary.LittleEndian.Uint16(raw[i*2:])
				if int(idx) >= len(sec.Palette) {
					continue
				}
				x := (i >> 8) & 0xf
				z := (i >> 4) & 0xf
				y := i & 0xf
				m.blocks[[4]int{baseX + x, sec.Y*16 + y, baseZ + z, layer}] = sec.Palette[idx]
			}
		}
		apply(sec.Blocks, 0)
		apply(sec.Blocks1, 1)
	}
}

func modelFromKeyframe(kf Keyframe) *clientModel {
	m := newClientModel()
	m.applyKeyframe(kf)
	return m
}

func encodeKeyframe(t *testing.T, e *encoder, a *actor.Actor) Keyframe {
	t.Helper()
	e.forceKey = true
	event, data, err := e.frame(a)
	if err != nil {
		t.Fatal(err)
	}
	if event != "keyframe" {
		t.Fatalf("event=%s", event)
	}
	var kf Keyframe
	if err := json.Unmarshal(data, &kf); err != nil {
		t.Fatal(err)
	}
	return kf
}

func encodeDelta(t *testing.T, e *encoder, a *actor.Actor) Delta {
	t.Helper()
	event, data, err := e.frame(a)
	if err != nil {
		t.Fatal(err)
	}
	if event != "delta" {
		t.Fatalf("event=%s want delta", event)
	}
	var d Delta
	if err := json.Unmarshal(data, &d); err != nil {
		t.Fatal(err)
	}
	return d
}

// TestDeltaSequenceReconstructsState is the Stage 1 check: keyframe then deltas
// must rebuild the same state a fresh keyframe describes.
func TestDeltaSequenceReconstructsState(t *testing.T) {
	a := testActor(t, "TestBot")
	w := a.World()
	addColumn(w, dfworld.ChunkPos{0, 0})
	w.SetBlock(cube.Pos{1, 70, 1}, block.Gold{})

	pig := entity.CreateFromPacket(&packet.AddActor{
		EntityRuntimeID: 42,
		EntityUniqueID:  -4200,
		EntityType:      "minecraft:pig",
	})
	pig.Move(cube.Pos{2, 70, 2}.Vec3Centre(), cube.Rotation{})
	w.AddEntity(pig)

	enc := newEncoder("TestBot", 4, 4)
	kf0 := encodeKeyframe(t, enc, a)
	model := modelFromKeyframe(kf0)

	// Block change.
	w.SetBlock(cube.Pos{1, 70, 1}, block.Dirt{})
	model.applyDelta(encodeDelta(t, enc, a))

	// Column add.
	addColumn(w, dfworld.ChunkPos{1, 0})
	w.SetBlock(cube.Pos{17, 70, 1}, block.Stone{})
	model.applyDelta(encodeDelta(t, enc, a))

	// Entity move.
	pig.Move(cube.Pos{3, 71, 3}.Vec3Centre(), cube.Rotation{90, 0})
	model.applyDelta(encodeDelta(t, enc, a))

	// Entity add.
	cow := entity.CreateFromPacket(&packet.AddActor{
		EntityRuntimeID: 43,
		EntityUniqueID:  -4300,
		EntityType:      "minecraft:cow",
	})
	w.AddEntity(cow)
	model.applyDelta(encodeDelta(t, enc, a))

	// Entity remove.
	w.RemoveEntityByUniqueID(-4200)
	model.applyDelta(encodeDelta(t, enc, a))

	// Column remove (outside radius after we shrink — simulate RemoveChunk).
	w.RemoveChunk(dfworld.ChunkPos{1, 0})
	model.applyDelta(encodeDelta(t, enc, a))

	// Dimension change → next frame is forced keyframe via DimensionChanged.
	enc.DimensionChanged()
	w.FlushChunks()
	w.FlushEntities(a.RuntimeID())
	w.SetDimension(1)
	addColumn(w, dfworld.ChunkPos{0, 0})
	w.SetBlock(cube.Pos{1, 70, 1}, block.Netherrack{})
	event, data, err := enc.frame(a)
	if err != nil {
		t.Fatal(err)
	}
	if event != "keyframe" {
		// DimensionChanged forces keyframe; also accept delta with world set.
		var d Delta
		if err := json.Unmarshal(data, &d); err != nil {
			t.Fatal(err)
		}
		model.applyDelta(d)
	} else {
		var kf Keyframe
		if err := json.Unmarshal(data, &kf); err != nil {
			t.Fatal(err)
		}
		model.applyKeyframe(kf)
	}

	fresh := encodeKeyframe(t, enc, a)
	want := modelFromKeyframe(fresh)

	if model.world.Dimension != want.world.Dimension {
		t.Fatalf("dimension=%d want %d", model.world.Dimension, want.world.Dimension)
	}
	if len(model.entities) != len(want.entities) {
		t.Fatalf("entities=%d want %d", len(model.entities), len(want.entities))
	}
	for rid, ent := range want.entities {
		got, ok := model.entities[rid]
		if !ok {
			t.Fatalf("missing entity %d", rid)
		}
		if got.Pos != ent.Pos || got.Type != ent.Type {
			t.Fatalf("entity %d mismatch: got %+v want %+v", rid, got, ent)
		}
	}
	// Spot-check the dirt we wrote and the netherrack after the dimension switch.
	goldPos := [4]int{1, 70, 1, 0}
	if b, ok := model.blocks[goldPos]; !ok || b.Name == "" {
		// After dimension change the block is netherrack in dim 1.
		if wantB, ok := want.blocks[goldPos]; ok {
			if model.blocks[goldPos].Name != wantB.Name {
				t.Fatalf("block at 1,70,1 = %q want %q", model.blocks[goldPos].Name, wantB.Name)
			}
		}
	}
	for pos, wantB := range want.blocks {
		if wantB.Name == "minecraft:air" || wantB.Name == "" {
			continue
		}
		got, ok := model.blocks[pos]
		if !ok || got.Name != wantB.Name {
			t.Fatalf("block %v = %+v want %+v", pos, got, wantB)
		}
	}
}

// TestSectionWindowDropsDistantSections ensures a vertical move emits air for
// sections that leave the actor's sectionRadius window.
func TestSectionWindowDropsDistantSections(t *testing.T) {
	a := testActor(t, "TestBot")
	w := a.World()
	addColumn(w, dfworld.ChunkPos{0, 0})
	w.SetBlock(cube.Pos{1, 70, 1}, block.Gold{})
	w.SetBlock(cube.Pos{1, 200, 1}, block.Dirt{})

	// Actor at y=70 → center section 4; sectionRadius 4 keeps y=70 (sec 4)
	// and drops y=200 (sec 12).
	a.Move(mgl64.Vec3{1, 70, 1}, cube.Rotation{})
	enc := newEncoder("TestBot", 4, 4)
	kf := encodeKeyframe(t, enc, a)
	if len(kf.Columns) != 1 {
		t.Fatalf("columns=%d want 1", len(kf.Columns))
	}
	var sawLow, sawHigh bool
	for _, sec := range kf.Columns[0].Sections {
		if sec.Y == 4 {
			sawLow = true
		}
		if sec.Y == 12 {
			sawHigh = true
		}
	}
	if !sawLow || sawHigh {
		t.Fatalf("sections at y=70 window: low=%v high=%v (want low only)", sawLow, sawHigh)
	}

	// Walk up so the high section enters and the low one leaves.
	a.Move(mgl64.Vec3{1, 200, 1}, cube.Rotation{})
	d := encodeDelta(t, enc, a)
	var lowCleared, highAdded bool
	for _, ch := range d.Blocks {
		if ch.Pos == [3]int{1, 70, 1} && ch.Block.Name == "minecraft:air" {
			lowCleared = true
		}
		if ch.Pos == [3]int{1, 200, 1} && ch.Block.Name != "" && ch.Block.Name != "minecraft:air" {
			highAdded = true
		}
	}
	if !lowCleared || !highAdded {
		t.Fatalf("window move delta: lowCleared=%v highAdded=%v blocks=%d", lowCleared, highAdded, len(d.Blocks))
	}
}

// TestSectionPaletteIndexOrder pins Bedrock's (x<<8)|(z<<4)|y packing.
func TestSectionPaletteIndexOrder(t *testing.T) {
	dfworld.DefaultBlockRegistry.Finalize()
	w := gw.NewWorld(false)
	col := addColumn(w, dfworld.ChunkPos{0, 0})
	w.SetBlock(cube.Pos{1, 70, 2}, block.Gold{})
	w.SetBlock(cube.Pos{3, 71, 4}, block.Dirt{})

	sub := col.SubChunk(70)
	sec, ok := encodeSectionForTest(w, sub, int(70)>>4)
	if !ok {
		t.Fatal("expected non-air section")
	}
	raw, err := base64.StdEncoding.DecodeString(sec.Blocks)
	if err != nil {
		t.Fatal(err)
	}
	goldRID := dfworld.BlockRuntimeID(block.Gold{})
	dirtRID := dfworld.BlockRuntimeID(block.Dirt{})
	var goldIdx, dirtIdx = -1, -1
	for i, b := range sec.Palette {
		if b.RID == goldRID {
			goldIdx = i
		}
		if b.RID == dirtRID {
			dirtIdx = i
		}
	}
	if goldIdx < 0 || dirtIdx < 0 {
		t.Fatalf("palette missing blocks: %+v", sec.Palette)
	}
	// Local coords inside the section: y=70 → local 6 (70 - 64), y=71 → local 7.
	check := func(x, y, z, wantIdx int) {
		i := (x << 8) | (z << 4) | y
		got := int(binary.LittleEndian.Uint16(raw[i*2:]))
		if got != wantIdx {
			t.Fatalf("index at (%d,%d,%d)=%d want %d", x, y, z, got, wantIdx)
		}
	}
	check(1, 6, 2, goldIdx)
	check(3, 7, 4, dirtIdx)
}
