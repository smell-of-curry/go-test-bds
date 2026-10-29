package viewer

import (
	"bytes"
	"encoding/json"
	"os"
	"path/filepath"
	"testing"

	"github.com/google/uuid"
	"github.com/sandertv/gophertunnel/minecraft/protocol"
	"github.com/smell-of-curry/go-test-bds/gotestbds/actor"
)

func TestRecorderWritesReplayableSSE(t *testing.T) {
	dir := t.TempDir()
	hub, err := New(Options{
		EncodeEveryTick: true,
		Address:         "127.0.0.1:0",
		ArtifactDir:     t.TempDir(),
		RecordDir:       dir,
		CacheDir:        filepath.Join(dir, "cache"),
		BaselineTag:     "v1.26.60",
	})
	if err != nil {
		t.Fatal(err)
	}
	defer hub.Close()

	s := hub.Register("Cam")
	a := testActor(t, "Cam")
	rgba := bytes.Repeat([]byte{4, 5, 6, 255}, 64*32)
	a.NoteSkin(uuid.MustParse("00000000-0000-0000-0000-000000000001"), protocol.Skin{
		SkinImageWidth:    64,
		SkinImageHeight:   32,
		SkinData:          rgba,
		SkinResourcePatch: []byte(`{"geometry":{"default":"geometry.humanoid.custom"}}`),
		ArmSize:           protocol.ArmSizeWide,
	})
	s.Tick(a)
	hub.Close()

	raw, err := os.ReadFile(filepath.Join(dir, "Cam.sse"))
	if err != nil {
		t.Fatal(err)
	}
	frames := splitSSE(t, raw)
	if len(frames) < 2 {
		t.Fatalf("frames %d", len(frames))
	}
	if frames[0].event != "hello" {
		t.Fatalf("first %s", frames[0].event)
	}
	var sawKey bool
	for _, fr := range frames {
		var head struct {
			V    int    `json:"v"`
			Type string `json:"type"`
		}
		if err := json.Unmarshal(fr.data, &head); err != nil {
			t.Fatalf("event %s: %v\n%s", fr.event, err, fr.data)
		}
		if head.Type == "" {
			t.Fatalf("event %s missing type", fr.event)
		}
		if fr.event == "keyframe" {
			sawKey = true
		}
	}
	if !sawKey {
		t.Fatal("recording has no keyframe")
	}

	takeRaw, err := os.ReadFile(filepath.Join(dir, "take.json"))
	if err != nil {
		t.Fatal(err)
	}
	var take struct {
		CacheDir    string   `json:"cacheDir"`
		BaselineTag string   `json:"baselineTag"`
		Bots        []string `json:"bots"`
		StartTime   string   `json:"startTime"`
		Protocol    string   `json:"protocol"`
	}
	if err := json.Unmarshal(takeRaw, &take); err != nil {
		t.Fatal(err)
	}
	if take.CacheDir == "" || take.BaselineTag != "v1.26.60" || take.Protocol != "1.26.60" || take.StartTime == "" {
		t.Fatalf("take %+v", take)
	}
	if len(take.Bots) != 1 || take.Bots[0] != "Cam" {
		t.Fatalf("bots %+v", take.Bots)
	}
	packs, err := os.ReadFile(filepath.Join(dir, "packs.json"))
	if err != nil {
		t.Fatal(err)
	}
	var packList []any
	if err := json.Unmarshal(packs, &packList); err != nil {
		t.Fatalf("packs %s: %v", packs, err)
	}

	hash := actor.HashSkin(64, 32, rgba)
	if _, err := os.Stat(filepath.Join(dir, "skins", hash+".png")); err != nil {
		t.Fatal(err)
	}
}

type sseFrame struct {
	event string
	data  []byte
}

func splitSSE(t *testing.T, raw []byte) []sseFrame {
	t.Helper()
	var out []sseFrame
	for _, block := range bytes.Split(raw, []byte("\n\n")) {
		block = bytes.TrimSpace(block)
		if len(block) == 0 || block[0] == ':' {
			continue
		}
		var fr sseFrame
		for _, line := range bytes.Split(block, []byte("\n")) {
			switch {
			case bytes.HasPrefix(line, []byte("event: ")):
				fr.event = string(line[len("event: "):])
			case bytes.HasPrefix(line, []byte("data: ")):
				fr.data = append(fr.data, line[len("data: "):]...)
			}
		}
		if fr.event == "" {
			t.Fatalf("frame without event: %s", block)
		}
		out = append(out, fr)
	}
	return out
}
