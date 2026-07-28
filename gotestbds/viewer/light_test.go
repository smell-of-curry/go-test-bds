package viewer

import (
	"encoding/base64"
	"encoding/json"
	"testing"

	"github.com/df-mc/dragonfly/server/block"
	"github.com/df-mc/dragonfly/server/block/cube"
	dfworld "github.com/df-mc/dragonfly/server/world"
)

// TestSectionLightEncodeOmitsDefaults checks skyLight/blockLight omission:
// absent skyLight ⇒ all 15, absent blockLight ⇒ all 0.
func TestSectionLightEncodeOmitsDefaults(t *testing.T) {
	dfworld.DefaultBlockRegistry.Finalize()
	a := testActor(t, "TestBot")
	w := a.World()
	addColumn(w, dfworld.ChunkPos{0, 0})
	// A single stone at y=70 — above it, open sky is the default (omit skyLight).
	w.SetBlock(cube.Pos{1, 70, 1}, block.Stone{})

	enc := newEncoder("TestBot", 4, 4)
	kf := encodeKeyframe(t, enc, a)
	col, ok := columnAt(kf.Columns, 0, 0)
	if !ok {
		t.Fatal("missing column 0,0")
	}

	var sawStone bool
	for _, sec := range col.Sections {
		if sec.Y != 4 { // 70 → section 4
			continue
		}
		sawStone = true
		// Section containing the stone is not all-max sky (stone occludes), so
		// skyLight should be present. blockLight should stay omitted (no emitters).
		if sec.SkyLight == "" {
			t.Fatal("expected skyLight on section with occlusion")
		}
		if sec.BlockLight != "" {
			t.Fatalf("blockLight should be omitted when all zero, got %q", sec.BlockLight)
		}
		raw, err := base64.StdEncoding.DecodeString(sec.SkyLight)
		if err != nil || len(raw) != 2048 {
			t.Fatalf("skyLight decode: len=%d err=%v", len(raw), err)
		}
	}
	if !sawStone {
		t.Fatal("stone section missing")
	}

	// Open-air section above the stone (if present) should omit both defaults.
	for _, sec := range col.Sections {
		if sec.Y <= 4 {
			continue
		}
		if sec.SkyLight != "" {
			t.Fatalf("section y=%d: skyLight should be omitted when all 15", sec.Y)
		}
		if sec.BlockLight != "" {
			t.Fatalf("section y=%d: blockLight should be omitted when all 0", sec.Y)
		}
	}
}

// TestSectionLightEncodeGlowstoneBlockLight checks a light block produces
// non-default blockLight bytes on the wire.
func TestSectionLightEncodeGlowstoneBlockLight(t *testing.T) {
	dfworld.DefaultBlockRegistry.Finalize()
	a := testActor(t, "TestBot")
	w := a.World()
	addColumn(w, dfworld.ChunkPos{0, 0})
	for x := 0; x < 16; x++ {
		for z := 0; z < 16; z++ {
			w.SetBlock(cube.Pos{x, 64, z}, block.Stone{})
		}
	}
	w.SetBlock(cube.Pos{8, 65, 8}, block.Glowstone{})

	enc := newEncoder("TestBot", 4, 4)
	kf := encodeKeyframe(t, enc, a)
	col, ok := columnAt(kf.Columns, 0, 0)
	if !ok {
		t.Fatal("missing column")
	}
	sec, ok := sectionAt(col, 4) // y 64–79
	if !ok {
		t.Fatal("missing section 4")
	}
	if sec.BlockLight == "" {
		t.Fatal("expected blockLight around glowstone")
	}
	raw, err := base64.StdEncoding.DecodeString(sec.BlockLight)
	if err != nil || len(raw) != 2048 {
		t.Fatalf("blockLight decode: len=%d err=%v", len(raw), err)
	}
	// Nibble at glowstone local (8,1,8) within section y=4 → local y = 65-64 = 1.
	index := (uint16(8) << 8) | (uint16(8) << 4) | uint16(1)
	level := (raw[index>>1] >> ((index & 1) << 2)) & 0xf
	if level != 15 {
		t.Fatalf("glowstone block light nibble = %d, want 15", level)
	}
}

// TestColumnBiomeSurfaceEncode checks 16×16 surface biomes + palette naming.
func TestColumnBiomeSurfaceEncode(t *testing.T) {
	dfworld.DefaultBlockRegistry.Finalize()
	a := testActor(t, "TestBot")
	w := a.World()
	col := addColumn(w, dfworld.ChunkPos{0, 0})
	// Default biome storage is 0 (ocean in dragonfly). Paint plains on half.
	plains, ok := dfworld.BiomeByName("plains")
	if !ok {
		t.Fatal("plains biome not registered")
	}
	pid := uint32(plains.EncodeBiome())
	for x := uint8(0); x < 16; x++ {
		for z := uint8(0); z < 16; z++ {
			w.SetBlock(cube.Pos{int(x), 70, int(z)}, block.Grass{})
			if x < 8 {
				col.SetBiome(x, 70, z, pid)
			}
		}
	}

	enc := newEncoder("TestBot", 4, 4)
	kf := encodeKeyframe(t, enc, a)
	wire, ok := columnAt(kf.Columns, 0, 0)
	if !ok {
		t.Fatal("missing column")
	}
	if wire.Biomes == "" || len(wire.BiomePalette) == 0 {
		t.Fatalf("biomes missing: palette=%v biomes=%q", wire.BiomePalette, wire.Biomes)
	}
	raw, err := base64.StdEncoding.DecodeString(wire.Biomes)
	if err != nil || len(raw) != 256 {
		t.Fatalf("biomes decode: len=%d err=%v", len(raw), err)
	}
	var plainsIdx = -1
	for i, e := range wire.BiomePalette {
		if e == "plains" {
			plainsIdx = i
			break
		}
	}
	if plainsIdx < 0 {
		t.Fatalf("palette missing plains: %v", wire.BiomePalette)
	}
	if raw[(0<<4)|0] != byte(plainsIdx) {
		t.Fatalf("surface (0,0) index=%d want plains=%d", raw[0], plainsIdx)
	}
}

// TestLightJSONRoundTrip ensures omitempty matches PROTOCOL defaults.
func TestLightJSONRoundTrip(t *testing.T) {
	sec := Section{Y: 4, Palette: []Block{airBlock()}, Blocks: "AA=="}
	b, err := json.Marshal(sec)
	if err != nil {
		t.Fatal(err)
	}
	var m map[string]any
	if err := json.Unmarshal(b, &m); err != nil {
		t.Fatal(err)
	}
	if _, ok := m["skyLight"]; ok {
		t.Fatal("empty skyLight must be omitted")
	}
	if _, ok := m["blockLight"]; ok {
		t.Fatal("empty blockLight must be omitted")
	}
}

func columnAt(cols []Column, x, z int32) (Column, bool) {
	for _, c := range cols {
		if c.X == x && c.Z == z {
			return c, true
		}
	}
	return Column{}, false
}

func sectionAt(col Column, y int) (Section, bool) {
	for _, s := range col.Sections {
		if s.Y == y {
			return s, true
		}
	}
	return Section{}, false
}
