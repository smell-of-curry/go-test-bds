package viewer

import (
	"encoding/json"
	"testing"

	"github.com/df-mc/dragonfly/server/block"
	"github.com/df-mc/dragonfly/server/block/cube"
	dfworld "github.com/df-mc/dragonfly/server/world"
)

// TestSlowSubscriberGetsLatestWorldThenKeyframe covers a subscriber that has
// fallen behind: it must not accumulate stale world frames, and once one has
// been skipped the next frame it receives has to be a keyframe rather than a
// delta against something it never saw.
func TestSlowSubscriberGetsLatestWorldThenKeyframe(t *testing.T) {
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
	fr, ok := sub.next()
	if !ok {
		t.Fatal("no frame after the first tick")
	}
	if fr.event != "keyframe" {
		t.Fatalf("first event=%s", fr.event)
	}

	// Several ticks without reading: only the newest world frame is kept.
	for i := 0; i < 5; i++ {
		a.World().SetBlock(cube.Pos{1, 70, 1}, block.Dirt{})
		if i%2 == 1 {
			a.World().SetBlock(cube.Pos{1, 70, 1}, block.Gold{})
		}
		s.Tick(a)
	}
	sub.mu.Lock()
	queued := len(sub.events)
	sub.mu.Unlock()
	if queued != 0 {
		t.Fatalf("world frames queued as events: %d", queued)
	}

	// Exactly one world frame is kept, and because a delta was skipped it is a
	// keyframe: a delta against a frame the subscriber never saw is unusable.
	fr, ok = sub.next()
	if !ok {
		t.Fatal("no world frame pending after five unread ticks")
	}
	if fr.event != "keyframe" {
		t.Fatalf("pending event=%s want keyframe after a skipped delta", fr.event)
	}
	var kf Keyframe
	if err := json.Unmarshal(fr.data, &kf); err != nil {
		t.Fatal(err)
	}
	if kf.Type != "keyframe" {
		t.Fatalf("type=%s", kf.Type)
	}
	if _, ok := sub.next(); ok {
		t.Fatal("more than one world frame kept for a subscriber that is behind")
	}
	if sub.needsResync() {
		t.Fatal("resync flag should clear once the keyframe is delivered")
	}
}

// TestEventsAreNeverDroppedForWorldFrames covers the other half of the split: a
// mark or capture cannot be repaired by a later keyframe, so a subscriber that
// is behind on world frames must still receive every event, in order.
func TestEventsAreNeverDroppedForWorldFrames(t *testing.T) {
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

	for i := 0; i < eventQueueCap/4; i++ {
		s.emitMark(Mark{Phase: "testStart", Suite: "s", Test: "t"})
		a.World().SetBlock(cube.Pos{1, 70, 1}, block.Dirt{})
		s.Tick(a)
	}

	marks := 0
	for {
		fr, ok := sub.next()
		if !ok {
			break
		}
		if fr.event == "mark" {
			marks++
		}
	}
	if marks != eventQueueCap/4 {
		t.Fatalf("marks delivered=%d want %d", marks, eventQueueCap/4)
	}
}

// TestEventQueueCapDiscardsOldest guards the sanity valve: a subscriber that has
// stopped reading for good must not grow memory without end.
func TestEventQueueCapDiscardsOldest(t *testing.T) {
	sub := &subscriber{wake: make(chan struct{}, 1)}
	for i := 0; i < eventQueueCap; i++ {
		if discarded := sub.pushEvent(encodedFrame{event: "mark"}); discarded != 0 {
			t.Fatalf("discarded at %d, below the cap", i)
		}
	}
	if discarded := sub.pushEvent(encodedFrame{event: "mark"}); discarded != 1 {
		t.Fatalf("discarded=%d at the cap, want 1", discarded)
	}
	sub.mu.Lock()
	defer sub.mu.Unlock()
	if len(sub.events) != eventQueueCap {
		t.Fatalf("queue length=%d want %d", len(sub.events), eventQueueCap)
	}
}

// TestDeltaDoesNotReplaceUnsentKeyframe covers the rule that keeps a subscriber
// which has fallen behind able to render at all: a delta applies to a world the
// client must already have, so it must never supersede a keyframe still waiting
// to be sent.
func TestDeltaDoesNotReplaceUnsentKeyframe(t *testing.T) {
	sub := &subscriber{wake: make(chan struct{}, 1)}

	sub.pushWorld(encodedFrame{event: "keyframe", data: []byte(`{"k":1}`)}, true)
	sub.pushWorld(encodedFrame{event: "delta", data: []byte(`{"d":1}`)}, false)

	f, ok := sub.next()
	if !ok {
		t.Fatal("nothing pending")
	}
	if f.event != "keyframe" {
		t.Fatalf("pending event=%s want keyframe", f.event)
	}
	if !sub.needsResync() {
		t.Fatal("skipping the delta must flag a resync")
	}
	if _, ok := sub.next(); ok {
		t.Fatal("the delta should have been dropped, not queued")
	}
}
