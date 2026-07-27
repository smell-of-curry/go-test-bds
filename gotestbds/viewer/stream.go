package viewer

import (
	"encoding/json"
	"sync"
	"sync/atomic"
	"time"

	"github.com/smell-of-curry/go-test-bds/gotestbds/actor"
)

// subscriberBuf is the per-subscriber frame buffer capacity.
//
// A send that would block is dropped and the subscriber flagged for resync so
// the bot tick loop never waits on a slow client. Capacity 8 is enough for a
// brief hitch without buffering unbounded memory.
const subscriberBuf = 8

// eventDeliveryTimeout bounds how long emitRaw waits for a subscriber that is
// not draining. Shorter than the default capture timeout, so a wedged viewer
// surfaces as a clean capture failure rather than an instruction that hangs.
const eventDeliveryTimeout = time.Second

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

type subscriber struct {
	ch     chan encodedFrame
	resync bool
}

// encodedFrame is an already-marshaled SSE event shared across subscribers.
type encodedFrame struct {
	event string
	data  []byte
}

func newStream(h *Hub, name string, radius int) *Stream {
	return &Stream{
		hub:  h,
		name: name,
		enc:  newEncoder(name, radius),
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
		if sub.resync {
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
		if sub.resync && event != "keyframe" {
			// Should not happen when needKey forced a keyframe; belt and braces.
			sub.resync = true
			continue
		}
		select {
		case sub.ch <- frame:
			if event == "keyframe" {
				sub.resync = false
			}
		default:
			// Drop rather than stall the tick loop; next frame is a keyframe.
			sub.resync = true
		}
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
		ch:     make(chan encodedFrame, subscriberBuf),
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
// subscriber. Safe from any goroutine — it never reads World, and it is never
// called from the bot goroutine, so waiting here cannot stall ticks.
//
// Unlike a world frame, a dropped mark or capture is not repaired by the next
// keyframe: it is an event, and losing it means a video segment that never
// closes or a screenshot that times out. So a full buffer is waited on briefly
// rather than dropped. The subscriber list is copied first — blocking while
// holding the lock would stall Tick, which is the thing this must never do.
func (s *Stream) emitRaw(event string, data []byte) {
	frame := encodedFrame{event: event, data: data}

	s.mu.Lock()
	subs := make([]*subscriber, 0, len(s.subs))
	for sub := range s.subs {
		subs = append(subs, sub)
	}
	s.mu.Unlock()

	for _, sub := range subs {
		select {
		case sub.ch <- frame:
		case <-time.After(eventDeliveryTimeout):
			if s.hub.log != nil {
				s.hub.log.Warn("viewer dropped event frame",
					"bot", s.name, "event", event)
			}
		}
	}
}

// emitCapture encodes and fans a capture request.
func (s *Stream) emitCapture(id, label string, minTick uint64) {
	cf := CaptureFrame{
		V:       SchemaVersion,
		Type:    "capture",
		Bot:     s.name,
		ID:      id,
		MinTick: minTick,
		Ext:     "png",
		Label:   label,
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
