package viewer

import (
	"bytes"
	"encoding/json"
	"flag"
	"os"
	"path/filepath"
	"sort"
	"testing"

	"github.com/df-mc/dragonfly/server/block"
	"github.com/df-mc/dragonfly/server/block/cube"
	dfworld "github.com/df-mc/dragonfly/server/world"
	"github.com/sandertv/gophertunnel/minecraft/protocol/packet"
	"github.com/smell-of-curry/go-test-bds/gotestbds/entity"
)

var updateFixture = flag.Bool("update-fixture", false, "rewrite gotestbds/viewer/testdata/go-stream.jsonl")

// TestGoStreamGolden pins the JSONL the Go encoder emits for a deterministic
// keyframe → deltas → mark sequence. The web app consumes the same file.
func TestGoStreamGolden(t *testing.T) {
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

	enc := newEncoder("TestBot", 4)
	var lines []string

	appendFrame := func(data []byte) {
		t.Helper()
		normalised, err := normaliseFrameJSON(data)
		if err != nil {
			t.Fatal(err)
		}
		lines = append(lines, string(normalised))
	}

	_, data, err := enc.frame(a)
	if err != nil {
		t.Fatal(err)
	}
	appendFrame(data)

	// Delta 1: block change.
	w.SetBlock(cube.Pos{1, 70, 1}, block.Dirt{})
	_, data, err = enc.frame(a)
	if err != nil {
		t.Fatal(err)
	}
	appendFrame(data)

	// Delta 2: entity move.
	pig.Move(cube.Pos{3, 71, 3}.Vec3Centre(), cube.Rotation{90, 0})
	_, data, err = enc.frame(a)
	if err != nil {
		t.Fatal(err)
	}
	appendFrame(data)

	// Delta 3: entity removal.
	w.RemoveEntityByUniqueID(-4200)
	_, data, err = enc.frame(a)
	if err != nil {
		t.Fatal(err)
	}
	appendFrame(data)

	mark, err := json.Marshal(markFrame{
		V:         SchemaVersion,
		Type:      "mark",
		Bot:       "TestBot",
		Tick:      a.CurrentTick(),
		Phase:     "testEnd",
		RunID:     "run-fixture",
		Suite:     "machines",
		Test:      "places a crate",
		Status:    "failed",
		Message:   "expected pokeb:crate, got minecraft:air",
		ElapsedMs: 3412,
	})
	if err != nil {
		t.Fatal(err)
	}
	appendFrame(mark)

	got := bytes.Join(byteLines(lines), []byte("\n"))
	if len(got) > 0 {
		got = append(got, '\n')
	}

	path := filepath.Join("testdata", "go-stream.jsonl")
	if *updateFixture {
		if err := os.MkdirAll(filepath.Dir(path), 0o755); err != nil {
			t.Fatal(err)
		}
		if err := os.WriteFile(path, got, 0o644); err != nil {
			t.Fatal(err)
		}
		t.Logf("wrote %s", path)
		return
	}

	want, err := os.ReadFile(path)
	if err != nil {
		t.Fatalf("read golden %s: %v (re-run with -update-fixture)", path, err)
	}
	if bytes.Equal(got, want) {
		return
	}

	gotLines := splitLines(got)
	wantLines := splitLines(want)
	n := len(gotLines)
	if len(wantLines) < n {
		n = len(wantLines)
	}
	for i := 0; i < n; i++ {
		if gotLines[i] != wantLines[i] {
			t.Fatalf("go-stream.jsonl differs at line %d\n got: %s\nwant: %s", i+1, gotLines[i], wantLines[i])
		}
	}
	t.Fatalf("go-stream.jsonl line count got=%d want=%d", len(gotLines), len(wantLines))
}

// normaliseFrameJSON sorts slices built from map iteration.
//
// Normalised: columns, entities, columnsAdded, entitiesAdded, entitiesUpdated,
// entitiesRemoved, columnsRemoved, blocks. JSON object key order is already
// stable (struct field order / encoding/json map key sort).
func normaliseFrameJSON(raw []byte) ([]byte, error) {
	var probe struct {
		Type string `json:"type"`
	}
	if err := json.Unmarshal(raw, &probe); err != nil {
		return nil, err
	}
	switch probe.Type {
	case "keyframe":
		var kf Keyframe
		if err := json.Unmarshal(raw, &kf); err != nil {
			return nil, err
		}
		sortColumns(kf.Columns)
		sortEntities(kf.Entities)
		return json.Marshal(kf)
	case "delta":
		var d Delta
		if err := json.Unmarshal(raw, &d); err != nil {
			return nil, err
		}
		sortColumns(d.ColumnsAdded)
		sortEntities(d.EntitiesAdded)
		sortEntities(d.EntitiesUpdated)
		sort.Slice(d.EntitiesRemoved, func(i, j int) bool {
			return d.EntitiesRemoved[i] < d.EntitiesRemoved[j]
		})
		sort.Slice(d.ColumnsRemoved, func(i, j int) bool {
			if d.ColumnsRemoved[i][0] != d.ColumnsRemoved[j][0] {
				return d.ColumnsRemoved[i][0] < d.ColumnsRemoved[j][0]
			}
			return d.ColumnsRemoved[i][1] < d.ColumnsRemoved[j][1]
		})
		sort.Slice(d.Blocks, func(i, j int) bool {
			a, b := d.Blocks[i].Pos, d.Blocks[j].Pos
			for k := 0; k < 3; k++ {
				if a[k] != b[k] {
					return a[k] < b[k]
				}
			}
			return d.Blocks[i].Layer < d.Blocks[j].Layer
		})
		return json.Marshal(d)
	default:
		return raw, nil
	}
}

func sortColumns(cols []Column) {
	sort.Slice(cols, func(i, j int) bool {
		if cols[i].X != cols[j].X {
			return cols[i].X < cols[j].X
		}
		return cols[i].Z < cols[j].Z
	})
}

func sortEntities(ents []Entity) {
	sort.Slice(ents, func(i, j int) bool {
		return ents[i].RID < ents[j].RID
	})
}

func byteLines(lines []string) [][]byte {
	out := make([][]byte, len(lines))
	for i, l := range lines {
		out[i] = []byte(l)
	}
	return out
}

func splitLines(b []byte) []string {
	b = bytes.TrimSuffix(b, []byte("\n"))
	if len(b) == 0 {
		return nil
	}
	parts := bytes.Split(b, []byte("\n"))
	out := make([]string, len(parts))
	for i, p := range parts {
		out[i] = string(p)
	}
	return out
}
