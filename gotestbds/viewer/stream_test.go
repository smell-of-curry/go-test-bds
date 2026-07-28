package viewer

import (
	"testing"

	"github.com/df-mc/dragonfly/server/block"
	"github.com/df-mc/dragonfly/server/block/cube"
	dfworld "github.com/df-mc/dragonfly/server/world"
)

// TestSlowSubscriberKeepsLatestWorldWithoutKeyframeRestart covers a subscriber
// that has fallen behind after its opening keyframe: only the newest world
// frame is kept, and superseding catch-up deltas must not force another
// keyframe (that restart is what thrashed remeshing under load).
func TestSlowSubscriberKeepsLatestWorldWithoutKeyframeRestart(t *testing.T) {
	hub, err := New(Options{EncodeEveryTick: true, Address: "127.0.0.1:0", ArtifactDir: t.TempDir()})
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

	fr, ok = sub.next()
	if !ok {
		t.Fatal("no world frame pending after five unread ticks")
	}
	if fr.event != "delta" {
		t.Fatalf("pending event=%s want delta after superseded catch-up (not a keyframe restart)", fr.event)
	}
	if _, ok := sub.next(); ok {
		t.Fatal("more than one world frame kept for a subscriber that is behind")
	}
	if sub.needsResync() {
		t.Fatal("resync must stay clear when only catch-up deltas were superseded")
	}
}

// TestEventsAreNeverDroppedForWorldFrames covers the other half of the split: a
// mark or capture cannot be repaired by a later keyframe, so a subscriber that
// is behind on world frames must still receive every event, in order.
func TestEventsAreNeverDroppedForWorldFrames(t *testing.T) {
	hub, err := New(Options{EncodeEveryTick: true, Address: "127.0.0.1:0", ArtifactDir: t.TempDir()})
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

// TestUnsentKeyframeIsRegeneratedWithFreshBlocks covers the loss window behind
// the keep-the-unsent-keyframe rule: while a keyframe sits unsent, frameFor
// must regenerate it from the current world rather than build a delta —
// pushWorld would drop that delta to keep the keyframe, silently losing its
// in-place block patches. The client's one keyframe must carry the new block.
func TestUnsentKeyframeIsRegeneratedWithFreshBlocks(t *testing.T) {
	hub, err := New(Options{EncodeEveryTick: true, Address: "127.0.0.1:0", ArtifactDir: t.TempDir()})
	if err != nil {
		t.Fatal(err)
	}
	defer hub.Close()

	s := hub.Register("TestBot")
	sub := s.attach()
	defer s.detach(sub)

	a := testActor(t, "TestBot")
	addColumn(a.World(), dfworld.ChunkPos{0, 0})

	// First tick arms the opening keyframe; the writer never dequeues it.
	s.Tick(a)
	sub.mu.Lock()
	if sub.pending == nil || sub.pending.event != "keyframe" {
		t.Fatal("expected an unsent keyframe pending after the first tick")
	}
	before := append([]byte(nil), sub.pending.data...)
	sub.mu.Unlock()

	// A block changes while the keyframe is still unsent.
	a.World().SetBlock(cube.Pos{1, 70, 1}, block.Gold{})
	s.Tick(a)

	fr, ok := sub.next()
	if !ok {
		t.Fatal("no frame pending after the second tick")
	}
	if fr.event != "keyframe" {
		t.Fatalf("pending event=%s want a regenerated keyframe, not a delta destined to be dropped", fr.event)
	}
	if string(fr.data) == string(before) {
		t.Fatal("keyframe was not regenerated; the block change is lost")
	}
	if _, ok := sub.next(); ok {
		t.Fatal("more than one world frame kept while behind")
	}
}

// TestDeltaDoesNotReplaceUnsentKeyframe covers the rule that keeps a subscriber
// which has fallen behind able to render at all: a delta applies to a world the
// client must already have, so it must never supersede a keyframe still waiting
// to be sent. Dropping the delta alone is not a lost base — no resync.
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
	if sub.needsResync() {
		t.Fatal("keeping an unsent keyframe must not flag a full resync")
	}
	if _, ok := sub.next(); ok {
		t.Fatal("the delta should have been dropped, not queued")
	}
}
