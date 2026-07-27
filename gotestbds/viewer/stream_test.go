package viewer

import (
	"encoding/json"
	"testing"
	"time"

	"github.com/df-mc/dragonfly/server/block"
	"github.com/df-mc/dragonfly/server/block/cube"
	dfworld "github.com/df-mc/dragonfly/server/world"
)

// TestBackpressureDropsThenKeyframes covers a slow subscriber: full buffer
// drops frames, and the next successful delivery is a keyframe rather than a
// corrupt delta against a missed frame.
func TestBackpressureDropsThenKeyframes(t *testing.T) {
	hub, err := New(Options{Address: "127.0.0.1:0", ArtifactDir: t.TempDir()})
	if err != nil {
		t.Fatal(err)
	}
	defer hub.Close()

	s := hub.Register("TestBot")
	sub := s.attach()
	defer s.detach(sub)

	a := testActor(t, "TestBot")
	addColumn(a.World(), dfworld.ChunkPos{0, 0})
	a.World().SetBlock(cube.Pos{1, 70, 1}, block.Gold{})

	// First tick → keyframe.
	s.Tick(a)
	select {
	case fr := <-sub.ch:
		if fr.event != "keyframe" {
			t.Fatalf("first event=%s", fr.event)
		}
	case <-time.After(time.Second):
		t.Fatal("timeout waiting for keyframe")
	}

	// Fill the buffer without reading so further sends drop.
	for i := 0; i < subscriberBuf+2; i++ {
		a.World().SetBlock(cube.Pos{1, 70, 1}, block.Dirt{})
		if i%2 == 1 {
			a.World().SetBlock(cube.Pos{1, 70, 1}, block.Gold{})
		}
		s.Tick(a)
	}
	if !sub.resync {
		t.Fatal("subscriber should be flagged for resync after drops")
	}

	// Drain whatever is buffered so the next send can land.
	drained := 0
	for {
		select {
		case <-sub.ch:
			drained++
		default:
			goto drained
		}
	}
drained:
	_ = drained

	// Next tick must be a keyframe (resync), not a delta.
	a.World().SetBlock(cube.Pos{2, 70, 2}, block.Stone{})
	s.Tick(a)
	select {
	case fr := <-sub.ch:
		if fr.event != "keyframe" {
			t.Fatalf("after drop event=%s want keyframe", fr.event)
		}
		var kf Keyframe
		if err := json.Unmarshal(fr.data, &kf); err != nil {
			t.Fatal(err)
		}
		if kf.Type != "keyframe" {
			t.Fatalf("type=%s", kf.Type)
		}
	case <-time.After(time.Second):
		t.Fatal("timeout waiting for resync keyframe")
	}
	if sub.resync {
		t.Fatal("resync flag should clear after a delivered keyframe")
	}
}
