package wire_test

import (
	"path/filepath"
	"runtime"
	"testing"

	"github.com/smell-of-curry/go-test-bds/gotestbds/wire"
	"github.com/smell-of-curry/go-test-bds/gotestbds/wire/testdata"
)

func TestPaletteResolvesGeometryWithoutBehaviourPack(t *testing.T) {
	reg := wire.NewRegistries()
	reg.LoadGameData(testdata.JoinGameData())

	def, ok := reg.Block(testdata.CustomCrateName)
	if !ok {
		t.Fatalf("palette missing %s", testdata.CustomCrateName)
	}
	if def.MolangVersion != 10 {
		t.Fatalf("molangVersion=%d want 10", def.MolangVersion)
	}
	if def.Components.Geometry != testdata.CustomCrateGeometry {
		t.Fatalf("geometry=%q want %q", def.Components.Geometry, testdata.CustomCrateGeometry)
	}
	mat, ok := def.Components.MaterialInstances["*"]
	if !ok {
		t.Fatal("missing * material instance")
	}
	if mat.Texture != testdata.CustomCrateTexture {
		t.Fatalf("texture=%q want %q", mat.Texture, testdata.CustomCrateTexture)
	}
	if mat.RenderMethod != "opaque" || !mat.FaceDimming || !mat.AmbientOcclusion {
		t.Fatalf("material flags unexpected: %+v", mat)
	}
	if def.Components.Transformation == nil || def.Components.Transformation.RY != 90 {
		t.Fatalf("transformation=%+v", def.Components.Transformation)
	}
	if def.Components.LightEmission == nil || *def.Components.LightEmission != 0.4 {
		t.Fatalf("lightEmission=%v", def.Components.LightEmission)
	}
	if len(def.Properties) != 1 || def.Properties[0].Name != "fixture:open" {
		t.Fatalf("properties=%+v", def.Properties)
	}
	if len(def.Permutations) != 1 || def.Permutations[0].Components.Geometry == "" {
		t.Fatalf("permutations=%+v", def.Permutations)
	}

	// Appearance from palette alone — no pack, no behaviour pack.
	resolved := wire.ResolveBlockAppearance(testdata.CustomCrateName, &def, nil)
	if resolved.Source != wire.SourcePalette {
		t.Fatalf("source=%s want palette", resolved.Source)
	}
	if resolved.Geometry != testdata.CustomCrateGeometry {
		t.Fatalf("resolved geometry=%q", resolved.Geometry)
	}
	if resolved.MaterialInstances["*"].Texture != testdata.CustomCrateTexture {
		t.Fatalf("resolved texture=%q", resolved.MaterialInstances["*"].Texture)
	}
}

func TestPaletteWinsOverBlocksJSON(t *testing.T) {
	_, file, _, ok := runtime.Caller(0)
	if !ok {
		t.Fatal("no caller")
	}
	path := filepath.Join(filepath.Dir(file), "testdata", "blocks.json")
	bj, err := wire.LoadBlocksJSON(path)
	if err != nil {
		t.Fatal(err)
	}
	entry, ok := bj[testdata.CustomCrateName]
	if !ok {
		t.Fatal("blocks.json missing custom crate")
	}
	tex, ok := entry.TextureName()
	if !ok || tex != "blocks_json_wrong_texture" {
		t.Fatalf("blocks.json texture=%q", tex)
	}

	reg := wire.NewRegistries()
	reg.LoadGameData(testdata.JoinGameData())
	def, _ := reg.Block(testdata.CustomCrateName)

	resolved := wire.ResolveBlockAppearance(testdata.CustomCrateName, &def, &entry)
	if resolved.Source != wire.SourcePalette {
		t.Fatalf("source=%s — palette must win over blocks.json", resolved.Source)
	}
	if resolved.MaterialInstances["*"].Texture != testdata.CustomCrateTexture {
		t.Fatalf("got texture %q from %s; blocks.json would have given %q",
			resolved.MaterialInstances["*"].Texture, resolved.Source, tex)
	}
	if resolved.Texture != "" {
		t.Fatalf("palette path must not copy blocks.json texture into Texture field, got %q", resolved.Texture)
	}

	// Without palette, blocks.json is used (vanilla / legacy path).
	stoneEntry := bj["minecraft:stone"]
	legacy := wire.ResolveBlockAppearance("minecraft:stone", nil, &stoneEntry)
	if legacy.Source != wire.SourceBlocksJSON || legacy.Texture != "stone" {
		t.Fatalf("legacy resolve=%+v", legacy)
	}
}

func TestItemRegistryAndActorProperties(t *testing.T) {
	reg := wire.NewRegistries()
	reg.ApplyItemRegistry(testdata.ItemRegistryPacket())
	item, ok := reg.Item("fixture:custom_widget")
	if !ok || !item.ComponentBased {
		t.Fatalf("item=%+v ok=%v", item, ok)
	}
	if item.Icon != "fixture_custom_widget" {
		t.Fatalf("icon=%q", item.Icon)
	}
	if _, ok := reg.Item("minecraft:stick"); ok {
		t.Fatal("vanilla name-only item must not be stored")
	}

	reg.ApplySyncActorProperty(testdata.SyncActorPropertyPacket())
	actor, ok := reg.ActorProps("minecraft:armadillo")
	if !ok {
		t.Fatal("missing armadillo props")
	}
	if len(actor.Properties) != 1 {
		t.Fatalf("props=%+v", actor.Properties)
	}
	p := actor.Properties[0]
	if p.Name != "minecraft:armadillo_state" || p.Type != "enum" || p.TypeID != wire.ActorPropEnum {
		t.Fatalf("prop=%+v", p)
	}
	if len(p.Enum) != 5 || p.Default != "unrolled" {
		t.Fatalf("enum/default=%+v", p)
	}
}

func TestFallbackClassification(t *testing.T) {
	cases := []struct {
		name       string
		b          wire.BlockRef
		inPalette  bool
		appearance bool
		want       wire.FallbackKind
	}{
		{"air", wire.BlockRef{Name: "minecraft:air", RID: 0}, false, false, wire.FallbackAbsent},
		{"empty zero", wire.BlockRef{}, false, false, wire.FallbackAbsent},
		{"unnamed", wire.BlockRef{Name: "", RID: 42}, false, false, wire.FallbackUnnamed},
		{"named unknown", wire.BlockRef{Name: "addon:missing", RID: 7}, false, false, wire.FallbackNamedUnknown},
		{"resolved", wire.BlockRef{Name: "fixture:custom_crate", RID: 9}, true, true, wire.FallbackResolved},
		{"in palette no pack yet", wire.BlockRef{Name: "fixture:custom_crate", RID: 9}, true, false, wire.FallbackNamedUnknown},
	}
	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			got := wire.ClassifyFallback(tc.b, tc.inPalette, tc.appearance)
			if got != tc.want {
				t.Fatalf("got %s want %s", got, tc.want)
			}
		})
	}
}
