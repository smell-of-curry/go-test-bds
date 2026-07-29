package viewer

import (
	"encoding/json"
	"sort"
	"sync"
	"sync/atomic"
	"time"

	"github.com/smell-of-curry/go-test-bds/gotestbds/actor"
)

// eventQueueCap bounds the per-subscriber event backlog.
//
// Marks and captures are rare and cannot be repaired by a later frame — a lost
// mark is a caption that never updates, a lost capture is a screenshot that
// times out — so they queue rather than drop. The cap only exists so a
// subscriber that has stopped reading for good cannot grow memory without end.
const eventQueueCap = 256

// streamHealthWindow is how often subscriber delivery is worth a look.
const streamHealthWindow = 2 * time.Second

// Stream is the per-bot snapshot stream.
//
// Tick and DimensionChanged must be called from the bot goroutine only — they
// read World/Actor. Subscriber attach/detach and emitRaw are safe from any
// goroutine.
type Stream struct {
	hub          *Hub
	name         string
	enc          *encoder
	columnBudget int

	mu   sync.Mutex
	subs map[*subscriber]struct{}

	// Written by Tick on the bot goroutine, read by emitMark on whichever
	// goroutine ran the instruction — atomic, not plain fields.
	lastTick atomic.Uint64
	healthAt time.Time
	lastDim  atomic.Int32

	// Hud event cursors — bot goroutine only. Chat/title/particle ride the
	// event lane so a slow world subscriber cannot lose a line a recording needs.
	lastMsgSeq      uint64
	lastTitleSeq    uint64
	lastParticleSeq uint64

	// lastEncodeAt throttles the world projection — bot goroutine only.
	lastEncodeAt time.Time
	// encodeInterval is worldEncodeInterval in production; tests zero it to
	// drive Tick faster than wall time.
	encodeInterval time.Duration
}

// worldEncodeInterval is the minimum gap between world projections. Projecting
// every loaded column each of the client's 20 ticks starved the bot loop below
// the client rate (37/100 ticks in a window), which lagged packet processing —
// and with it every instruction — behind real time until test statuses missed
// their deadlines. The viewer interpolates entity motion and terrain changes
// arrive as deltas, so 10 Hz is indistinguishable in the recording.
const worldEncodeInterval = 100 * time.Millisecond

// Resync reasons appear on the stream-health warning so a thrash loop names
// itself instead of only climbing a counter on the burnt-in overlay.
const (
	resyncReasonAttach             = "attach"
	resyncReasonDimension          = "dimension"
	resyncReasonEncoderKeyframe    = "encoder-keyframe"
	resyncReasonSupersededKeyframe = "superseded-keyframe"
)

// subscriber holds what one SSE connection has yet to be sent.
//
// Two lanes, because the two kinds of frame fail differently. Events queue and
// never drop. World frames keep only the newest: a viewer that has fallen behind
// wants the current world, not a backlog of stale ones it will render and throw
// away.
//
// Superseding a catch-up delta only re-queues that frame's columns — the client
// still holds every column already delivered, so a full keyframe restart would
// wipe valid state and feed the remesh thrash loop. A full restart (resync) is
// reserved for a fresh attach or a superseded keyframe the client never got.
//
// Column delivery is paced per subscriber: sentColumns tracks what the writer
// has actually dequeued, and a pending frame's columnsDelivered are treated as
// already claimed so a superseded frame does not double-count.
type subscriber struct {
	mu      sync.Mutex
	events  []encodedFrame
	pending *encodedFrame
	dropped int
	// replaced counts world frames superseded before the writer sent them, and
	// sent counts what reached the socket. A subscriber that cannot keep up shows
	// as replaced climbing while sent stands still — which is what a frozen
	// viewer looks like from this side, and it used to say nothing at all.
	replaced             int
	sent                 int
	resync               bool
	resyncReason         string // set while resync is armed
	lastResyncReason     string // sticky for health logs after the keyframe clears it
	lastReportedSent     int
	lastReportedReplaced int

	// sentColumns is what this subscriber has been given on the wire. Touched
	// from the bot goroutine (Tick planning) and the HTTP writer (next).
	sentColumns map[[2]int32]struct{}

	// wake carries no data; it only tells the writer there is something to send.
	wake chan struct{}
}

// encodedFrame is an already-marshaled SSE event. World frames may carry
// column bookkeeping applied when the writer dequeues them.
type encodedFrame struct {
	event string
	data  []byte

	// resetSent clears sentColumns before applying columnsDelivered (keyframe).
	resetSent        bool
	columnsDelivered [][2]int32
	columnsRemoved   [][2]int32
	// columnsTouched are already-delivered columns this delta patched in place
	// (blocks / state). On supersede they must be unclaimed so the next frame
	// re-sends the full column; catch-up columnsDelivered unclaim themselves
	// when pending is dropped.
	columnsTouched [][2]int32
}

// signal wakes the writer without blocking a producer.
func (sub *subscriber) signal() {
	select {
	case sub.wake <- struct{}{}:
	default:
	}
}

// pushEvent queues a mark or capture frame.
//
// @param f The frame to deliver.
// @returns the number of events discarded because the subscriber stopped
// reading entirely, or 0 in the normal case.
func (sub *subscriber) pushEvent(f encodedFrame) int {
	sub.mu.Lock()
	discarded := 0
	if len(sub.events) >= eventQueueCap {
		sub.events = sub.events[1:]
		discarded = 1
		sub.dropped++
	}
	sub.events = append(sub.events, f)
	sub.mu.Unlock()
	sub.signal()
	return discarded
}

// pushWorld replaces the pending world frame with a newer one.
//
// A delta never replaces a keyframe that has not been sent yet: the client needs
// the keyframe to have anything to apply the delta to, and dropping it left a
// subscriber that had fallen behind receiving deltas against a world it had
// never been given. A keyframe replaces anything, because it is a fresh base.
//
// Superseding a pending delta re-queues only that frame's columns. Superseding
// a pending keyframe forces a full restart — the client never received a base.
//
// @param f The frame to deliver.
// @param keyframe Whether f is a keyframe rather than a delta.
func (sub *subscriber) pushWorld(f encodedFrame, keyframe bool) {
	sub.mu.Lock()
	defer sub.mu.Unlock()

	if sub.pending != nil {
		if !keyframe && sub.pending.event == "keyframe" {
			// Keep the unsent keyframe; the dropped delta is not a lost base.
			sub.replaced++
			return
		}
		sub.replaced++
		if sub.pending.event == "keyframe" {
			// Lost an unsent keyframe — paced progress from before it is void.
			sub.lastResyncReason = resyncReasonSupersededKeyframe
			clear(sub.sentColumns)
		} else {
			sub.requeueSupersededColumnsLocked(*sub.pending)
		}
	}
	frame := f
	sub.pending = &frame
	if keyframe {
		sub.resync = false
		sub.resyncReason = ""
	}
	sub.signal()
}

// releasePendingDeltaLocked drops an unread catch-up delta and re-queues its
// columns. Keyframes are left in place. Caller holds sub.mu.
func (sub *subscriber) releasePendingDeltaLocked() {
	if sub.pending == nil || sub.pending.event == "keyframe" {
		return
	}
	sub.replaced++
	sub.requeueSupersededColumnsLocked(*sub.pending)
	sub.pending = nil
}

// requeueSupersededColumnsLocked unclaims columns from a dropped pending delta.
// Caller holds sub.mu.
//
// @param f The superseded frame whose in-flight columns must be offered again.
func (sub *subscriber) requeueSupersededColumnsLocked(f encodedFrame) {
	// columnsDelivered were claimed only via pending; replacing pending drops
	// that claim. In-place patches lived in sentColumns and need an explicit
	// unclaim so the next frame re-sends the full column.
	for _, key := range f.columnsTouched {
		delete(sub.sentColumns, key)
	}
}

// next takes the frame to send, events first.
//
// @returns the frame and true, or false when there is nothing to send.
func (sub *subscriber) next() (encodedFrame, bool) {
	sub.mu.Lock()
	defer sub.mu.Unlock()
	if len(sub.events) > 0 {
		f := sub.events[0]
		sub.events = sub.events[1:]
		return f, true
	}
	if sub.pending != nil {
		f := *sub.pending
		sub.pending = nil
		sub.applyColumnDelivery(f)
		sub.sent++
		return f, true
	}
	return encodedFrame{}, false
}

// applyColumnDelivery updates sentColumns for a dequeued world frame.
// Caller holds sub.mu.
func (sub *subscriber) applyColumnDelivery(f encodedFrame) {
	if sub.sentColumns == nil {
		sub.sentColumns = make(map[[2]int32]struct{})
	}
	if f.resetSent {
		clear(sub.sentColumns)
	}
	for _, key := range f.columnsRemoved {
		delete(sub.sentColumns, key)
	}
	for _, key := range f.columnsDelivered {
		sub.sentColumns[key] = struct{}{}
	}
}

// projectedSent is sentColumns plus any columns claimed by the pending frame.
// Caller holds sub.mu.
func (sub *subscriber) projectedSent() map[[2]int32]struct{} {
	if sub.pending != nil && sub.pending.resetSent {
		out := make(map[[2]int32]struct{}, len(sub.pending.columnsDelivered))
		for _, key := range sub.pending.columnsDelivered {
			out[key] = struct{}{}
		}
		return out
	}
	out := make(map[[2]int32]struct{}, len(sub.sentColumns)+8)
	for key := range sub.sentColumns {
		out[key] = struct{}{}
	}
	if sub.pending == nil {
		return out
	}
	for _, key := range sub.pending.columnsRemoved {
		delete(out, key)
	}
	for _, key := range sub.pending.columnsDelivered {
		out[key] = struct{}{}
	}
	return out
}

// markResync flags the subscriber for a fresh keyframe and drops paced progress.
//
// @param reason Why the client has nothing valid to keep.
func (sub *subscriber) markResync(reason string) {
	sub.mu.Lock()
	defer sub.mu.Unlock()
	sub.resync = true
	sub.resyncReason = reason
	sub.lastResyncReason = reason
	clear(sub.sentColumns)
	sub.pending = nil
}

// stats reports delivery counters for the health log.
//
// @returns frames sent, frames superseded before sending, queued events, and
// the last resync reason (empty when none has fired).
func (sub *subscriber) stats() (sent, replaced, queued int, resyncReason string) {
	sub.mu.Lock()
	defer sub.mu.Unlock()
	reason := sub.resyncReason
	if reason == "" {
		reason = sub.lastResyncReason
	}
	return sub.sent, sub.replaced, len(sub.events), reason
}

// needsResync reports whether the next world frame must be a keyframe.
func (sub *subscriber) needsResync() bool {
	sub.mu.Lock()
	defer sub.mu.Unlock()
	return sub.resync
}

func newStream(h *Hub, name string, radius, sectionRadius, columnBudget int) *Stream {
	if columnBudget <= 0 {
		columnBudget = DefaultColumnBudget
	}
	return &Stream{
		hub:            h,
		name:           name,
		enc:            newEncoder(name, radius, sectionRadius),
		columnBudget:   columnBudget,
		subs:           make(map[*subscriber]struct{}),
		encodeInterval: worldEncodeInterval,
	}
}

// Tick encodes one frame from the live Actor and fans it out.
//
// Must run on the bot goroutine. Projection happens once; each subscriber gets
// a paced slice of columns based on what it has already been sent. A slow
// subscriber never blocks this call.
func (s *Stream) Tick(a *actor.Actor) {
	s.reportHealth(time.Now())
	s.lastTick.Store(a.CurrentTick())
	s.lastDim.Store(a.Dimension())
	s.hub.setBotMeta(s.name, s.lastTick.Load(), s.lastDim.Load())

	s.mu.Lock()
	nsubs := len(s.subs)
	subs := make([]*subscriber, 0, nsubs)
	for sub := range s.subs {
		subs = append(subs, sub)
	}
	s.mu.Unlock()

	if nsubs == 0 {
		// Nobody watching: skip encode entirely. A later attach sets resync so
		// the next Tick emits a fresh keyframe — the run must behave the same
		// whether or not a viewer is attached.
		return
	}

	// Chat and titles stay per-tick (cheap cursor reads); the world projection
	// is the expensive part and runs at most every encodeInterval.
	if now := time.Now(); !s.enc.forceKey && now.Sub(s.lastEncodeAt) < s.encodeInterval {
		s.emitHudEvents(a)
		return
	}
	s.lastEncodeAt = time.Now()

	cur, err := s.enc.project(a)
	if err != nil {
		if s.hub.log != nil {
			s.hub.log.Error("viewer encode", "bot", s.name, "error", err)
		}
		return
	}

	globalKey := s.enc.prev == nil || s.enc.forceKey
	var shared Delta
	if !globalKey {
		shared = s.enc.delta(cur)
	}
	s.enc.forceKey = false
	s.enc.prev = cur

	if globalKey {
		for _, sub := range subs {
			sub.markResync(resyncReasonEncoderKeyframe)
		}
	}

	for _, sub := range subs {
		frame, keyframe, err := s.frameFor(sub, cur, shared, a)
		if err != nil {
			if s.hub.log != nil {
				s.hub.log.Error("viewer encode", "bot", s.name, "error", err)
			}
			continue
		}
		sub.pushWorld(frame, keyframe)
	}

	s.emitHudEvents(a)
}

// frameFor builds one subscriber's paced world frame from the shared projection.
//
// @param sub The subscriber to build for.
// @param cur The projected view for this tick.
// @param shared The encoder delta against the previous tick (empty on keyframe).
// @param a The live actor (registries on keyframe).
// @returns the encoded frame, whether it is a keyframe, and any marshal error.
func (s *Stream) frameFor(sub *subscriber, cur *viewState, shared Delta, a *actor.Actor) (encodedFrame, bool, error) {
	sub.mu.Lock()
	// Drop an unread catch-up delta before sampling claims so its columns are
	// offered again on this frame. An unsent keyframe stays — a delta must not
	// tear down the base the client still needs.
	sub.releasePendingDeltaLocked()
	// While a keyframe sits unsent, regenerate it fresh rather than building a
	// delta: pushWorld would drop that delta to keep the keyframe, silently
	// losing its in-place block patches. A keyframe is a full base, so the
	// newest one loses nothing — the client only ever receives one.
	needKey := sub.resync ||
		(sub.pending != nil && sub.pending.event == "keyframe")
	budget := s.columnBudget
	var claimed map[[2]int32]struct{}
	if needKey {
		// Resync ignores prior progress; resetSent clears sentColumns on dequeue.
		claimed = map[[2]int32]struct{}{}
	} else {
		claimed = sub.projectedSent()
	}
	sub.mu.Unlock()

	if needKey {
		pendingKeys := pendingColumnKeys(cur, claimed)
		batch := pendingKeys
		if len(batch) > budget {
			batch = batch[:budget]
		}
		cols := make([]Column, 0, len(batch))
		for _, key := range batch {
			cols = append(cols, cur.columns[key])
		}
		kf := Keyframe{
			V:              SchemaVersion,
			Type:           "keyframe",
			Bot:            s.name,
			Tick:           cur.tick,
			World:          cur.world,
			Actor:          cur.actor,
			Columns:        cols,
			Entities:       entitiesSlice(cur.entities),
			UI:             mustDecodeUI(cur.uiBytes),
			ColumnsPending: len(pendingKeys) - len(batch),
			Registries:     encodeRegistries(a.WireRegistries()),
		}
		data, err := json.Marshal(kf)
		if err != nil {
			return encodedFrame{}, false, err
		}
		return encodedFrame{
			event:            "keyframe",
			data:             data,
			resetSent:        true,
			columnsDelivered: append([][2]int32(nil), batch...),
		}, true, nil
	}

	var removed [][2]int32
	for _, key := range shared.ColumnsRemoved {
		if _, ok := claimed[key]; ok {
			removed = append(removed, key)
			delete(claimed, key)
		}
	}
	for key := range claimed {
		if _, ok := cur.columns[key]; !ok {
			removed = append(removed, key)
			delete(claimed, key)
		}
	}
	// Light/biome refreshes arrive as encoder ColumnsAdded for columns the
	// subscriber already holds. Unclaim them so they re-enter the budgeted
	// catch-up batch instead of appending past ColumnBudget.
	for _, c := range shared.ColumnsAdded {
		key := [2]int32{c.X, c.Z}
		delete(claimed, key)
	}

	pendingKeys := pendingColumnKeys(cur, claimed)
	batch := pendingKeys
	if len(batch) > budget {
		batch = batch[:budget]
	}

	d := Delta{
		V:               SchemaVersion,
		Type:            "delta",
		Bot:             s.name,
		Tick:            cur.tick,
		ColumnsRemoved:  removed,
		ColumnsPending:  len(pendingKeys) - len(batch),
		EntitiesAdded:   shared.EntitiesAdded,
		EntitiesUpdated: shared.EntitiesUpdated,
		EntitiesRemoved: shared.EntitiesRemoved,
		UI:              shared.UI,
	}
	act := cur.actor
	d.Actor = &act

	for _, st := range shared.ColumnsState {
		key := [2]int32{st.X, st.Z}
		if _, ok := claimed[key]; ok {
			d.ColumnsState = append(d.ColumnsState, st)
		}
	}
	for _, bc := range shared.Blocks {
		key := [2]int32{int32(bc.Pos[0] >> 4), int32(bc.Pos[2] >> 4)}
		// Skip block patches for columns this frame re-sends whole — the
		// column payload already has the new blocks + light.
		inBatch := false
		for _, b := range batch {
			if b == key {
				inBatch = true
				break
			}
		}
		if inBatch {
			continue
		}
		if _, ok := claimed[key]; ok {
			d.Blocks = append(d.Blocks, bc)
		}
	}
	if len(batch) > 0 {
		d.ColumnsAdded = make([]Column, 0, len(batch))
		for _, key := range batch {
			d.ColumnsAdded = append(d.ColumnsAdded, cur.columns[key])
		}
	}

	data, err := json.Marshal(d)
	if err != nil {
		return encodedFrame{}, false, err
	}
	touched := columnsTouchedByDelta(d)
	return encodedFrame{
		event:            "delta",
		data:             data,
		columnsDelivered: append([][2]int32(nil), batch...),
		columnsRemoved:   append([][2]int32(nil), removed...),
		columnsTouched:   touched,
	}, false, nil
}

// columnsTouchedByDelta lists already-held columns a delta patches in place.
//
// @param d The delta about to be queued.
// @returns unique column keys referenced by blocks or columnsState.
func columnsTouchedByDelta(d Delta) [][2]int32 {
	if len(d.Blocks) == 0 && len(d.ColumnsState) == 0 {
		return nil
	}
	seen := make(map[[2]int32]struct{}, len(d.ColumnsState)+8)
	var out [][2]int32
	for _, st := range d.ColumnsState {
		key := [2]int32{st.X, st.Z}
		if _, ok := seen[key]; ok {
			continue
		}
		seen[key] = struct{}{}
		out = append(out, key)
	}
	for _, bc := range d.Blocks {
		key := [2]int32{int32(bc.Pos[0] >> 4), int32(bc.Pos[2] >> 4)}
		if _, ok := seen[key]; ok {
			continue
		}
		seen[key] = struct{}{}
		out = append(out, key)
	}
	return out
}

// pendingColumnKeys lists columns in cur that the subscriber has not claimed,
// nearest to the actor first (Chebyshev), then by (x,z).
func pendingColumnKeys(cur *viewState, claimed map[[2]int32]struct{}) [][2]int32 {
	out := make([][2]int32, 0, len(cur.columns))
	for key := range cur.columns {
		if _, ok := claimed[key]; ok {
			continue
		}
		out = append(out, key)
	}
	sort.Slice(out, func(i, j int) bool {
		di := chebyshev(out[i][0]-cur.centerX, out[i][1]-cur.centerZ)
		dj := chebyshev(out[j][0]-cur.centerX, out[j][1]-cur.centerZ)
		if di != dj {
			return di < dj
		}
		if out[i][0] != out[j][0] {
			return out[i][0] < out[j][0]
		}
		return out[i][1] < out[j][1]
	})
	return out
}

// reportHealth logs once per window while a subscriber is losing world frames.
//
// Called from Tick on the bot goroutine.
//
// @param now The current time, passed in so tests need no clock.
func (s *Stream) reportHealth(now time.Time) {
	if s.hub.log == nil {
		return
	}
	if s.healthAt.IsZero() {
		s.healthAt = now
		return
	}
	if now.Sub(s.healthAt) < streamHealthWindow {
		return
	}
	elapsed := now.Sub(s.healthAt)
	s.healthAt = now

	s.mu.Lock()
	subs := make([]*subscriber, 0, len(s.subs))
	for sub := range s.subs {
		subs = append(subs, sub)
	}
	s.mu.Unlock()

	for i, sub := range subs {
		sent, replaced, queued, resyncReason := sub.stats()
		delta := sent - sub.lastReportedSent
		sub.lastReportedSent = sent
		droppedNow := replaced - sub.lastReportedReplaced
		sub.lastReportedReplaced = replaced
		// Losing the odd frame to a hitch is normal. Sending nothing at all
		// while frames pile up is a viewer that has stopped, and the only other
		// symptom is a recording where the tick never changes.
		if delta > 0 || droppedNow == 0 {
			continue
		}
		s.hub.log.Warn("viewer subscriber is not keeping up",
			"bot", s.name,
			"subscriber", i,
			"sentInWindow", delta,
			"supersededInWindow", droppedNow,
			"queuedEvents", queued,
			"resyncReason", resyncReason,
			"windowMs", elapsed.Milliseconds(),
		)
	}
}

// DimensionChanged forces a keyframe on the next Tick for every subscriber.
func (s *Stream) DimensionChanged(from, to int32) {
	_ = from
	_ = to
	s.enc.DimensionChanged()
	s.mu.Lock()
	for sub := range s.subs {
		sub.markResync(resyncReasonDimension)
	}
	s.mu.Unlock()
}

// attach adds a subscriber. The caller sends hello itself; the next Tick that
// sees resync delivers a keyframe.
func (s *Stream) attach() *subscriber {
	sub := &subscriber{
		wake:             make(chan struct{}, 1),
		resync:           true,
		resyncReason:     resyncReasonAttach,
		lastResyncReason: resyncReasonAttach,
		sentColumns:      make(map[[2]int32]struct{}),
	}
	s.mu.Lock()
	s.subs[sub] = struct{}{}
	s.mu.Unlock()
	s.hub.setAttached(s.name, s.Attached())
	return sub
}

// detach removes a subscriber.
func (s *Stream) detach(sub *subscriber) {
	s.mu.Lock()
	delete(s.subs, sub)
	s.mu.Unlock()
	s.hub.setAttached(s.name, s.Attached())
}

// Attached returns the live subscriber count.
func (s *Stream) Attached() int {
	s.mu.Lock()
	defer s.mu.Unlock()
	return len(s.subs)
}

// emitRaw fans an already-encoded non-world frame (mark/capture) to every
// subscriber. Safe from any goroutine — it never reads World.
//
// Never blocks and never drops: events queue per subscriber. Losing one is not
// repaired by the next keyframe — it is a caption that never updates or a
// screenshot that times out — so the only discard is at the sanity cap, and that
// says so.
func (s *Stream) emitRaw(event string, data []byte) {
	frame := encodedFrame{event: event, data: data}

	s.mu.Lock()
	subs := make([]*subscriber, 0, len(s.subs))
	for sub := range s.subs {
		subs = append(subs, sub)
	}
	s.mu.Unlock()

	for _, sub := range subs {
		if discarded := sub.pushEvent(frame); discarded > 0 && s.hub.log != nil {
			s.hub.log.Warn("viewer subscriber is not reading; dropped oldest events",
				"bot", s.name, "event", event, "queue", eventQueueCap)
		}
	}
}

// emitCapture encodes and fans a capture request.
func (s *Stream) emitCapture(id, label string, minTick uint64, timeoutMs int64, noSettle bool) {
	cf := CaptureFrame{
		V:         SchemaVersion,
		Type:      "capture",
		Bot:       s.name,
		ID:        id,
		MinTick:   minTick,
		TimeoutMs: timeoutMs,
		NoSettle:  noSettle,
		Ext:       "png",
		Label:     label,
	}
	data, _ := json.Marshal(cf)
	s.emitRaw("capture", data)
}

// emitMark encodes and fans a mark frame for this bot.
func (s *Stream) emitMark(m Mark) {
	mf := markFrame{
		V:         SchemaVersion,
		Type:      "mark",
		Bot:       s.name,
		Tick:      s.lastTick.Load(),
		Phase:     m.Phase,
		RunID:     m.RunID,
		Suite:     m.Suite,
		Test:      m.Test,
		Status:    m.Status,
		Message:   m.Message,
		ElapsedMs: m.ElapsedMs,
	}
	data, _ := json.Marshal(mf)
	s.emitRaw("mark", data)
}

// emitHudEvents fans chat/title/particle changes on the event lane (never
// dropped for world backpressure). Protocol noise is filtered here and in encodeUI.
//
// @param a Live actor on the bot goroutine.
func (s *Stream) emitHudEvents(a *actor.Actor) {
	tick := a.CurrentTick()

	msgs := a.MessagesFromSeq(s.lastMsgSeq)
	if seq := a.MessageSeq(); seq > s.lastMsgSeq {
		s.lastMsgSeq = seq
	}
	for _, m := range msgs {
		if isProtocolChatNoise(m.Text) {
			continue
		}
		cf := ChatFrame{
			V:    SchemaVersion,
			Type: "chat",
			Bot:  s.name,
			Tick: tick,
			Text: resolveLangLines(flattenRawtext(m.Text)),
		}
		data, _ := json.Marshal(cf)
		s.emitRaw("chat", data)
	}

	titleSeq := a.TitleSeq()
	if titleSeq != 0 && titleSeq != s.lastTitleSeq {
		s.lastTitleSeq = titleSeq
		st := a.ScreenTitle()
		// The event lane must sanitize like encodeUI: run 15 shipped raw
		// "&_phone:" tokens and rawtext JSON here, and the HUD drew them.
		title := resolveLangLines(filterHudControlText(flattenRawtext(st.Title)))
		subtitle := resolveLangLines(filterHudControlText(flattenRawtext(st.Subtitle)))
		actionBar := resolveLangLines(filterHudControlText(flattenRawtext(st.ActionBar)))
		rawEmpty := st.Title == "" && st.Subtitle == "" && st.ActionBar == ""
		if !rawEmpty && title == "" && subtitle == "" && actionBar == "" {
			// Pure control-token traffic: a real client's HUD would not change,
			// so neither may ours — emitting a clear frame here would wipe a
			// visible title every time the sidebar updates.
		} else {
			tf := TitleFrame{
				V:            SchemaVersion,
				Type:         "title",
				Bot:          s.name,
				Tick:         tick,
				Title:        title,
				Subtitle:     subtitle,
				ActionBar:    actionBar,
				FadeInTicks:  st.FadeInTicks,
				StayTicks:    st.StayTicks,
				FadeOutTicks: st.FadeOutTicks,
				Clear:        rawEmpty,
			}
			data, _ := json.Marshal(tf)
			s.emitRaw("title", data)
		}
	}

	spawns := a.ParticlesFromSeq(s.lastParticleSeq)
	if seq := a.ParticleSeq(); seq > s.lastParticleSeq {
		s.lastParticleSeq = seq
	}
	for _, p := range spawns {
		pf := ParticleFrame{
			V:         SchemaVersion,
			Type:      "particle",
			Bot:       s.name,
			Tick:      tick,
			Name:      p.Name,
			Pos:       [3]float32{p.Position[0], p.Position[1], p.Position[2]},
			Dimension: p.Dimension,
		}
		if p.EntityUniqueID != -1 {
			pf.EntityID = p.EntityUniqueID
		}
		data, _ := json.Marshal(pf)
		s.emitRaw("particle", data)
	}
}
