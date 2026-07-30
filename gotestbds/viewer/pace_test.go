package viewer

import (
	"encoding/json"
	"testing"

	"github.com/df-mc/dragonfly/server/block"
	"github.com/df-mc/dragonfly/server/block/cube"
	dfworld "github.com/df-mc/dragonfly/server/world"
	"github.com/go-gl/mathgl/mgl64"
	"github.com/smell-of-curry/go-test-bds/gotestbds/actor"
)

// populatePacedWorld fills a Chebyshev radius neighbourhood with 8 non-air
// sections per column — the shape that made unpaced keyframes multi-megabyte.
func populatePacedWorld(t testing.TB, radius int) *actor.Actor {
	t.Helper()
	a := testActor(t, "PaceBot")
	a.Move(mgl64.Vec3{8, 70, 8}, cube.Rotation{})
	w := a.World()
	for dx := int32(-radius); dx <= int32(radius); dx++ {
		for dz := int32(-radius); dz <= int32(radius); dz++ {
			addColumn(w, dfworld.ChunkPos{dx, dz})
			baseX := int(dx) * 16
			baseZ := int(dz) * 16
			for _, y := range []int{0, 16, 32, 48, 64, 80, 96, 112} {
				w.SetBlock(cube.Pos{baseX + 1, y, baseZ + 1}, block.Stone{})
			}
		}
	}
	return a
}

func collectStreamFrames(t *testing.T, s *Stream, sub *subscriber, a *actor.Actor, ticks int) []encodedFrame {
	t.Helper()
	var out []encodedFrame
	for i := 0; i < ticks; i++ {
		s.Tick(a)
		for {
			fr, ok := sub.next()
			if !ok {
				break
			}
			out = append(out, fr)
		}
	}
	return out
}

func applyStreamFrames(t *testing.T, frames []encodedFrame) *clientModel {
	t.Helper()
	m := newClientModel()
	sawKey := false
	for _, fr := range frames {
		switch fr.event {
		case "keyframe":
			var kf Keyframe
			if err := json.Unmarshal(fr.data, &kf); err != nil {
				t.Fatal(err)
			}
			m.applyKeyframe(kf)
			sawKey = true
		case "delta":
			if !sawKey {
				t.Fatal("delta arrived before keyframe")
			}
			var d Delta
			if err := json.Unmarshal(fr.data, &d); err != nil {
				t.Fatal(err)
			}
			m.applyDelta(d)
		}
	}
	if !sawKey {
		t.Fatal("no keyframe in stream")
	}
	return m
}

// TestPacedWorldReconstructsAcrossFrames delivers an 81-column world under a
// small budget and checks keyframe + columnsAdded rebuild the encoder's set.
func TestPacedWorldReconstructsAcrossFrames(t *testing.T) {
	const budget = 4
	hub, err := New(Options{EncodeEveryTick: true,
		Address:      "127.0.0.1:0",
		ArtifactDir:  t.TempDir(),
		Radius:       4,
		ColumnBudget: budget,
	})
	if err != nil {
		t.Fatal(err)
	}
	defer hub.Close()

	s := hub.Register("PaceBot")
	sub := s.attach()
	defer s.detach(sub)

	a := populatePacedWorld(t, 4)
	wantCols := (2*4 + 1) * (2*4 + 1) // 81
	// ceil(81/4) = 21 ticks to finish catch-up, plus a spare.
	frames := collectStreamFrames(t, s, sub, a, 24)
	model := applyStreamFrames(t, frames)

	if len(model.columns) != wantCols {
		t.Fatalf("columns=%d want %d", len(model.columns), wantCols)
	}

	// Encoder's full projection is the ground truth.
	encCols := s.enc.prev.columns
	if len(encCols) != wantCols {
		t.Fatalf("encoder columns=%d want %d", len(encCols), wantCols)
	}
	for key, want := range encCols {
		got, ok := model.columns[key]
		if !ok {
			t.Fatalf("missing column %v", key)
		}
		if got.State != want.State || len(got.Sections) != len(want.Sections) {
			t.Fatalf("column %v mismatch: state=%s/%s sections=%d/%d",
				key, got.State, want.State, len(got.Sections), len(want.Sections))
		}
	}

	var kf Keyframe
	if err := json.Unmarshal(frames[0].data, &kf); err != nil {
		t.Fatal(err)
	}
	if frames[0].event != "keyframe" {
		t.Fatalf("first event=%s", frames[0].event)
	}
	if len(kf.Columns) > budget {
		t.Fatalf("keyframe columns=%d over budget %d", len(kf.Columns), budget)
	}
	if kf.ColumnsPending != wantCols-len(kf.Columns) {
		t.Fatalf("columnsPending=%d want %d", kf.ColumnsPending, wantCols-len(kf.Columns))
	}
}

// TestMidRunAttachGetsKeyframeThenColumns covers a subscriber that joins after
// the encoder already has state: keyframe first, then paced columnsAdded, never
// a delta before the keyframe.
func TestMidRunAttachGetsKeyframeThenColumns(t *testing.T) {
	const budget = 3
	hub, err := New(Options{EncodeEveryTick: true,
		Address:      "127.0.0.1:0",
		ArtifactDir:  t.TempDir(),
		Radius:       4,
		ColumnBudget: budget,
	})
	if err != nil {
		t.Fatal(err)
	}
	defer hub.Close()

	s := hub.Register("PaceBot")
	a := populatePacedWorld(t, 4)

	// Warm the encoder with an early subscriber that drains fully.
	early := s.attach()
	_ = collectStreamFrames(t, s, early, a, 30)
	s.detach(early)

	late := s.attach()
	defer s.detach(late)

	frames := collectStreamFrames(t, s, late, a, 30)
	if len(frames) == 0 {
		t.Fatal("no frames for late subscriber")
	}
	if frames[0].event != "keyframe" {
		t.Fatalf("first event=%s want keyframe", frames[0].event)
	}
	for i, fr := range frames {
		if fr.event == "delta" && i == 0 {
			t.Fatal("delta before keyframe")
		}
		if fr.event != "keyframe" && fr.event != "delta" {
			continue
		}
		if i > 0 && frames[0].event != "keyframe" {
			t.Fatal("keyframe missing")
		}
	}
	// Explicit: no delta precedes the first keyframe in the late stream.
	for i, fr := range frames {
		if fr.event == "keyframe" {
			break
		}
		if fr.event == "delta" {
			t.Fatalf("delta at index %d before any keyframe", i)
		}
	}

	model := applyStreamFrames(t, frames)
	wantCols := 81
	if len(model.columns) != wantCols {
		t.Fatalf("late subscriber columns=%d want %d", len(model.columns), wantCols)
	}
}

// TestUnchangedColumnNotResent ensures a column that has not changed is not
// re-encoded onto the wire after the subscriber has it.
func TestUnchangedColumnNotResent(t *testing.T) {
	hub, err := New(Options{EncodeEveryTick: true,
		Address:      "127.0.0.1:0",
		ArtifactDir:  t.TempDir(),
		Radius:       4,
		ColumnBudget: 4,
	})
	if err != nil {
		t.Fatal(err)
	}
	defer hub.Close()

	s := hub.Register("PaceBot")
	sub := s.attach()
	defer s.detach(sub)

	a := populatePacedWorld(t, 4)
	_ = collectStreamFrames(t, s, sub, a, 30)

	// Steady-state ticks with no world edits: no columnsAdded.
	for i := 0; i < 5; i++ {
		s.Tick(a)
		fr, ok := sub.next()
		if !ok {
			t.Fatal("expected actor delta every tick")
		}
		if fr.event != "delta" {
			t.Fatalf("event=%s want delta", fr.event)
		}
		var d Delta
		if err := json.Unmarshal(fr.data, &d); err != nil {
			t.Fatal(err)
		}
		if len(d.ColumnsAdded) != 0 {
			t.Fatalf("tick %d re-sent %d columns", i, len(d.ColumnsAdded))
		}
		if d.ColumnsPending != 0 {
			t.Fatalf("tick %d columnsPending=%d", i, d.ColumnsPending)
		}
		if _, ok := sub.next(); ok {
			t.Fatal("more than one world frame per tick")
		}
	}
}

// countColumnPayloads sums keyframe.columns + delta.columnsAdded across frames.
func countColumnPayloads(t *testing.T, frames []encodedFrame) int {
	t.Helper()
	n := 0
	for _, fr := range frames {
		switch fr.event {
		case "keyframe":
			var kf Keyframe
			if err := json.Unmarshal(fr.data, &kf); err != nil {
				t.Fatal(err)
			}
			n += len(kf.Columns)
		case "delta":
			var d Delta
			if err := json.Unmarshal(fr.data, &d); err != nil {
				t.Fatal(err)
			}
			n += len(d.ColumnsAdded)
		}
	}
	return n
}

// TestSlowSubscriberColumnDeliveryConverges guards the thrash loop: a writer
// that falls behind while the world keeps changing must not restart the whole
// catch-up on every supersede. Delivered column payloads stay a small multiple
// of the world size, not proportional to ticks elapsed.
func TestSlowSubscriberColumnDeliveryConverges(t *testing.T) {
	const (
		budget     = 4
		radius     = 4
		ticks      = 500
		drainEvery = 5 // consume one frame per N produced
	)
	wantCols := (2*radius + 1) * (2*radius + 1) // 81
	drains := ticks / drainEvery
	// Thrash baseline: every drained frame is a fresh paced keyframe of `budget`
	// columns, so payloads grow with ticks/drainEvery — well above 3× world.
	thrashFloor := drains * budget

	hub, err := New(Options{EncodeEveryTick: true,
		Address:      "127.0.0.1:0",
		ArtifactDir:  t.TempDir(),
		Radius:       radius,
		ColumnBudget: budget,
	})
	if err != nil {
		t.Fatal(err)
	}
	defer hub.Close()

	s := hub.Register("PaceBot")
	sub := s.attach()
	defer s.detach(sub)

	a := populatePacedWorld(t, radius)
	var frames []encodedFrame
	keyframes := 0
	for i := 0; i < ticks; i++ {
		// Keep the world moving so every unread tick produces a real supersede.
		a.World().SetBlock(cube.Pos{1, 70, 1}, block.Dirt{})
		if i%2 == 1 {
			a.World().SetBlock(cube.Pos{1, 70, 1}, block.Gold{})
		}
		s.Tick(a)
		if (i+1)%drainEvery != 0 {
			continue
		}
		fr, ok := sub.next()
		if !ok {
			t.Fatalf("tick %d: expected a pending world frame", i)
		}
		if fr.event == "keyframe" {
			keyframes++
		}
		frames = append(frames, fr)
		drainEventLane(sub)
		if fr, ok := sub.next(); ok && isWorldFrame(fr.event) {
			t.Fatalf("more than one world frame pending: %s", fr.event)
		}
	}

	delivered := countColumnPayloads(t, frames)
	t.Logf("delivered %d column payloads for %d-column world (%.2fx) over %d ticks; keyframes=%d; thrashFloor=%d",
		delivered, wantCols, float64(delivered)/float64(wantCols), ticks, keyframes, thrashFloor)

	// Healthy paced catch-up: one pass (~81) plus a little churn for the edited
	// column and superseded in-flight batches. The thrash bug restarts the whole
	// world on every supersede and lands near ticks/drainEvery * budget.
	const maxMultiple = 3
	if delivered > wantCols*maxMultiple {
		t.Fatalf("delivered %d column payloads for a %d-column world over %d ticks (drain 1/%d); want <= %dx world size (thrash restarts catch-up)",
			delivered, wantCols, ticks, drainEvery, maxMultiple)
	}
	if delivered >= thrashFloor {
		t.Fatalf("delivered %d payloads looks like per-drain keyframe restarts (thrashFloor=%d)", delivered, thrashFloor)
	}
	// After the opening keyframe, supersedes must stay on the delta path.
	if keyframes != 1 {
		t.Fatalf("keyframes during slow drain=%d want 1 (full restart on every supersede)", keyframes)
	}

	// Drain whatever catch-up remains and confirm the client can finish.
	for i := 0; i < 40; i++ {
		s.Tick(a)
		for {
			fr, ok := sub.next()
			if !ok {
				break
			}
			frames = append(frames, fr)
		}
	}
	model := applyStreamFrames(t, frames)
	if len(model.columns) != wantCols {
		t.Fatalf("after catch-up columns=%d want %d", len(model.columns), wantCols)
	}
}

// TestSupersededCatchUpDeltaRequeuesOnlyItsColumns covers the cheap supersede
// path: dropping an unsent catch-up delta must not clear already-delivered
// columns or force a keyframe restart.
func TestSupersededCatchUpDeltaRequeuesOnlyItsColumns(t *testing.T) {
	const budget = 4
	hub, err := New(Options{EncodeEveryTick: true,
		Address:      "127.0.0.1:0",
		ArtifactDir:  t.TempDir(),
		Radius:       4,
		ColumnBudget: budget,
	})
	if err != nil {
		t.Fatal(err)
	}
	defer hub.Close()

	s := hub.Register("PaceBot")
	sub := s.attach()
	defer s.detach(sub)

	a := populatePacedWorld(t, 4)
	// Deliver the paced keyframe + enough deltas to claim a solid prefix.
	_ = collectStreamFrames(t, s, sub, a, 8)

	sub.mu.Lock()
	before := len(sub.sentColumns)
	var sentBefore [][2]int32
	for key := range sub.sentColumns {
		sentBefore = append(sentBefore, key)
	}
	sub.mu.Unlock()
	if before < budget*2 {
		t.Fatalf("setup sentColumns=%d; need a delivered prefix", before)
	}

	// Leave one catch-up delta pending, then supersede it with a newer tick.
	s.Tick(a)
	sub.mu.Lock()
	if sub.pending == nil || sub.pending.event != "delta" {
		sub.mu.Unlock()
		t.Fatal("expected a pending catch-up delta")
	}
	pendingBatch := append([][2]int32(nil), sub.pending.columnsDelivered...)
	sub.mu.Unlock()
	if len(pendingBatch) == 0 {
		t.Fatal("pending delta carried no columns; cannot assert re-queue")
	}

	a.World().SetBlock(cube.Pos{1, 70, 1}, block.Stone{})
	edited := [2]int32{0, 0} // chunk covering {1,70,1}
	s.Tick(a)                // supersedes the unread delta

	if sub.needsResync() {
		t.Fatal("superseding a catch-up delta must not flag a full keyframe resync")
	}
	sub.mu.Lock()
	for _, key := range sentBefore {
		if _, ok := sub.sentColumns[key]; !ok {
			t.Fatalf("already-delivered column %v was cleared on supersede", key)
		}
	}
	sub.mu.Unlock()

	fr, ok := sub.next()
	if !ok {
		t.Fatal("no frame after supersede")
	}
	if fr.event == "keyframe" {
		t.Fatal("superseded catch-up delta must not restart with a keyframe")
	}
	// Already-delivered columns must not appear again on this frame — except
	// the column just edited, which is re-sent so sky/block light stay in sync
	// (BlockChange deltas do not carry light).
	var d Delta
	if err := json.Unmarshal(fr.data, &d); err != nil {
		t.Fatal(err)
	}
	sentSet := make(map[[2]int32]struct{}, len(sentBefore))
	for _, key := range sentBefore {
		sentSet[key] = struct{}{}
	}
	for _, c := range d.ColumnsAdded {
		key := [2]int32{c.X, c.Z}
		if key == edited {
			continue
		}
		if _, ok := sentSet[key]; ok {
			t.Fatalf("re-sent already-delivered column %v after supersede", key)
		}
	}
}

// TestSupersededKeyframeRestartsCleanly keeps the expensive path: losing an
// unsent keyframe means the client has nothing valid, so the next delivery
// restarts from an empty sentColumns set.
func TestSupersededKeyframeRestartsCleanly(t *testing.T) {
	const budget = 4
	hub, err := New(Options{EncodeEveryTick: true,
		Address:      "127.0.0.1:0",
		ArtifactDir:  t.TempDir(),
		Radius:       4,
		ColumnBudget: budget,
	})
	if err != nil {
		t.Fatal(err)
	}
	defer hub.Close()

	s := hub.Register("PaceBot")
	sub := s.attach()
	defer s.detach(sub)

	a := populatePacedWorld(t, 4)
	s.Tick(a)
	sub.mu.Lock()
	if sub.pending == nil || sub.pending.event != "keyframe" {
		sub.mu.Unlock()
		t.Fatal("expected pending keyframe")
	}
	firstBatch := append([][2]int32(nil), sub.pending.columnsDelivered...)
	sub.mu.Unlock()

	// Force another encoder keyframe while the first is still unsent.
	s.DimensionChanged(0, 0)
	s.Tick(a)

	fr, ok := sub.next()
	if !ok {
		t.Fatal("no frame after superseded keyframe")
	}
	if fr.event != "keyframe" {
		t.Fatalf("event=%s want keyframe restart", fr.event)
	}
	if !fr.resetSent {
		t.Fatal("restart keyframe must reset sentColumns on dequeue")
	}
	var kf Keyframe
	if err := json.Unmarshal(fr.data, &kf); err != nil {
		t.Fatal(err)
	}
	if len(kf.Columns) == 0 || len(kf.Columns) > budget {
		t.Fatalf("restart keyframe columns=%d", len(kf.Columns))
	}
	// A clean restart re-offers the nearest columns (same first batch shape).
	if len(firstBatch) != len(fr.columnsDelivered) {
		t.Fatalf("restart batch=%d first batch=%d", len(fr.columnsDelivered), len(firstBatch))
	}
}

// TestPerFramePayloadUnderBudget asserts marshalled frame size stays under a
// few hundred KB for a world several times the budget.
func TestPerFramePayloadUnderBudget(t *testing.T) {
	const budget = 4
	// Dense column ≈ 8 sections × (~11 KB blocks + ~3 KB skyLight) ≈ 110 KB;
	// 4 columns ≈ 440 KB wire before JSON/palette/biome overhead. Light nibbles
	// for non-default sky (anything under a platform) ride every section.
	const maxFrameBytes = 900_000

	hub, err := New(Options{EncodeEveryTick: true,
		Address:      "127.0.0.1:0",
		ArtifactDir:  t.TempDir(),
		Radius:       4,
		ColumnBudget: budget,
	})
	if err != nil {
		t.Fatal(err)
	}
	defer hub.Close()

	s := hub.Register("PaceBot")
	sub := s.attach()
	defer s.detach(sub)

	a := populatePacedWorld(t, 4)
	frames := collectStreamFrames(t, s, sub, a, 24)

	var maxSize int
	for i, fr := range frames {
		if n := len(fr.data); n > maxSize {
			maxSize = n
		}
		if len(fr.data) > maxFrameBytes {
			t.Fatalf("frame %d (%s) is %d bytes, over %d", i, fr.event, len(fr.data), maxFrameBytes)
		}
		switch fr.event {
		case "keyframe":
			var kf Keyframe
			if err := json.Unmarshal(fr.data, &kf); err != nil {
				t.Fatal(err)
			}
			if len(kf.Columns) > budget {
				t.Fatalf("keyframe columns=%d over budget", len(kf.Columns))
			}
		case "delta":
			var d Delta
			if err := json.Unmarshal(fr.data, &d); err != nil {
				t.Fatal(err)
			}
			if len(d.ColumnsAdded) > budget {
				t.Fatalf("delta columnsAdded=%d over budget", len(d.ColumnsAdded))
			}
		}
	}
	t.Logf("max marshalled frame=%d bytes across %d frames (budget=%d columns)", maxSize, len(frames), budget)

	// Sanity: an unpaced keyframe of this world is multi-megabyte.
	enc := newEncoder("PaceBot", 4, 4)
	enc.forceKey = true
	_, full, err := enc.frame(a)
	if err != nil {
		t.Fatal(err)
	}
	if len(full) < maxFrameBytes*2 {
		t.Fatalf("unpaced keyframe only %d bytes; fixture too small to justify pacing", len(full))
	}
	t.Logf("unpaced keyframe=%d bytes (%.1fx largest paced frame)", len(full), float64(len(full))/float64(maxSize))
}
