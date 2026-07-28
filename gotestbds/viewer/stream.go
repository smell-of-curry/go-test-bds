package viewer

import (
	"encoding/json"
	"sync"
	"sync/atomic"

	"github.com/smell-of-curry/go-test-bds/gotestbds/actor"
)

// eventQueueCap bounds the per-subscriber event backlog.
//
// Marks and captures are rare and cannot be repaired by a later frame — a lost
// mark is a caption that never updates, a lost capture is a screenshot that
// times out — so they queue rather than drop. The cap only exists so a
// subscriber that has stopped reading for good cannot grow memory without end.
const eventQueueCap = 256

// Stream is the per-bot snapshot stream.
//
// Tick and DimensionChanged must be called from the bot goroutine only — they
// read World/Actor. Subscriber attach/detach and emitRaw are safe from any
// goroutine.
type Stream struct {
	hub  *Hub
	name string
	enc  *encoder

	mu   sync.Mutex
	subs map[*subscriber]struct{}

	// Written by Tick on the bot goroutine, read by emitMark on whichever
	// goroutine ran the instruction — atomic, not plain fields.
	lastTick atomic.Uint64
	lastDim  atomic.Int32
}

// subscriber holds what one SSE connection has yet to be sent.
//
// Two lanes, because the two kinds of frame fail differently. Events queue and
// never drop. World frames keep only the newest: a viewer that has fallen behind
// wants the current world, not a backlog of stale ones it will render and throw
// away. Skipping a delta invalidates the client's state, so any replacement
// flags a resync and the next frame it receives is a fresh keyframe.
type subscriber struct {
	mu      sync.Mutex
	events  []encodedFrame
	pending *encodedFrame
	dropped int
	resync  bool

	// wake carries no data; it only tells the writer there is something to send.
	wake chan struct{}
}

// encodedFrame is an already-marshaled SSE event shared across subscribers.
type encodedFrame struct {
	event string
	data  []byte
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
// @param f The frame to deliver.
// @param keyframe Whether f is a keyframe rather than a delta.
func (sub *subscriber) pushWorld(f encodedFrame, keyframe bool) {
	sub.mu.Lock()
	if sub.pending != nil && !keyframe {
		// The frame being replaced was never sent, so the client cannot apply
		// what builds on it.
		sub.resync = true
	}
	frame := f
	sub.pending = &frame
	if keyframe {
		sub.resync = false
	}
	sub.mu.Unlock()
	sub.signal()
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
		return f, true
	}
	return encodedFrame{}, false
}

// needsResync reports whether the next world frame must be a keyframe.
func (sub *subscriber) needsResync() bool {
	sub.mu.Lock()
	defer sub.mu.Unlock()
	return sub.resync
}

func newStream(h *Hub, name string, radius, sectionRadius int) *Stream {
	return &Stream{
		hub:  h,
		name: name,
		enc:  newEncoder(name, radius, sectionRadius),
		subs: make(map[*subscriber]struct{}),
	}
}

// Tick encodes one frame from the live Actor and fans it out.
//
// Must run on the bot goroutine. Encoding happens once; every subscriber
// receives the same byte slice. A subscriber whose buffer is full drops the
// frame and is flagged so its next delivery is a fresh keyframe.
func (s *Stream) Tick(a *actor.Actor) {
	s.lastTick.Store(a.CurrentTick())
	s.lastDim.Store(a.Dimension())
	s.hub.setBotMeta(s.name, s.lastTick.Load(), s.lastDim.Load())

	s.mu.Lock()
	needKey := s.enc.prev == nil || s.enc.forceKey
	for sub := range s.subs {
		if sub.needsResync() {
			needKey = true
			break
		}
	}
	nsubs := len(s.subs)
	s.mu.Unlock()

	if nsubs == 0 {
		// Nobody watching: skip encode entirely. A later attach sets resync so
		// the next Tick emits a fresh keyframe — the run must behave the same
		// whether or not a viewer is attached.
		return
	}

	if needKey {
		s.enc.forceKey = true
	}
	event, data, err := s.enc.frame(a)
	if err != nil {
		if s.hub.log != nil {
			s.hub.log.Error("viewer encode", "bot", s.name, "error", err)
		}
		return
	}
	frame := encodedFrame{event: event, data: data}

	s.mu.Lock()
	defer s.mu.Unlock()
	for sub := range s.subs {
		if sub.needsResync() && event != "keyframe" {
			// Should not happen when needKey forced a keyframe; belt and braces.
			continue
		}
		sub.pushWorld(frame, event == "keyframe")
	}
}

// DimensionChanged forces a keyframe on the next Tick.
func (s *Stream) DimensionChanged(from, to int32) {
	_ = from
	_ = to
	s.enc.DimensionChanged()
}

// attach adds a subscriber. The caller sends hello itself; the next Tick that
// sees resync delivers a keyframe.
func (s *Stream) attach() *subscriber {
	sub := &subscriber{
		wake:   make(chan struct{}, 1),
		resync: true,
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
func (s *Stream) emitCapture(id, label string, minTick uint64, timeoutMs int64) {
	cf := CaptureFrame{
		V:         SchemaVersion,
		Type:      "capture",
		Bot:       s.name,
		ID:        id,
		MinTick:   minTick,
		TimeoutMs: timeoutMs,
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
