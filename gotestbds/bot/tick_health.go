package bot

import (
	"fmt"
	"log/slog"
	"runtime"
	"sync/atomic"
	"time"

	"github.com/sandertv/gophertunnel/minecraft/protocol/packet"
)

// tickTarget is the client tick rate the bot simulates at.
const tickTarget = 20

// tickInterval is how often the tick loop wants to run a tick.
const tickInterval = time.Second / tickTarget

// tickHealthWindow is how long a measurement window lasts.
const tickHealthWindow = 5 * time.Second

// tickHealthFloor is the fraction of the target rate below which the window is
// worth a log line. Chunk streaming legitimately costs a few ticks; losing most
// of them is a different thing entirely.
const tickHealthFloor = 0.75

// tickHealth measures how many ticks the loop actually managed against how many
// it should have, and names the packet that cost the most time in that window.
//
// Tick rate is not cosmetic: physics, navigation, and every timeout expressed in
// ticks run off it, and a bot ticking at a fraction of 20 Hz moves and reacts at
// a fraction of the speed a player would. `time.Ticker` drops ticks instead of
// queueing them, so a slow packet handler silently costs simulated time — which
// is exactly the failure this measures.
type tickHealth struct {
	windowStart time.Time
	ticks       int
	packets     int
	slowestName string
	slowest     time.Duration

	// Written by the bot goroutine, read by the stall watchdog.
	lastTickUnixNano atomic.Int64
}

// tickStallTimeout is how long without a tick counts as stalled.
//
// Well past a slow chunk decode, well short of a run's patience.
const tickStallTimeout = 3 * time.Second

// watchStalls reports when the tick loop stops ticking altogether, with the
// stack of every goroutine at that moment.
//
// A loop that ticks slowly reports itself; a loop that stops cannot — the report
// runs inside it. Everything downstream then freezes with no explanation: the
// world stops updating, the viewer's tick sticks, marks stop arriving, and the
// only symptom is a recording where nothing changes. The stack says which call
// is blocking instead of leaving it to be guessed at.
//
// @param log Where to report; nil disables the watchdog.
// @param done Closed when the loop exits.
func (h *tickHealth) watchStalls(log *slog.Logger, done <-chan struct{}) {
	if log == nil {
		return
	}
	go func() {
		ticker := time.NewTicker(time.Second)
		defer ticker.Stop()
		reported := false
		for {
			select {
			case <-done:
				return
			case <-ticker.C:
			}
			last := h.lastTickUnixNano.Load()
			if last == 0 {
				continue
			}
			stalled := time.Since(time.Unix(0, last))
			if stalled < tickStallTimeout {
				reported = false
				continue
			}
			if reported {
				continue
			}
			reported = true
			buf := make([]byte, 16<<10)
			n := runtime.Stack(buf, true)
			log.Warn("bot tick loop has stalled",
				"stalledMs", stalled.Milliseconds(),
				"goroutines", string(buf[:n]),
			)
		}
	}()
}

// tick records one simulated tick.
func (h *tickHealth) tick() {
	h.ticks++
	h.lastTickUnixNano.Store(time.Now().UnixNano())
}

// packet records the cost of handling one packet.
//
// @param pk The packet just handled.
// @param took How long handling it took.
func (h *tickHealth) packet(pk packet.Packet, took time.Duration) {
	h.packets++
	if took <= h.slowest {
		return
	}
	h.slowest = took
	h.slowestName = packetName(pk)
}

// report logs and resets the window once it is over, staying quiet while the
// loop is keeping up.
//
// @param log Where to report; nil is tolerated so tests can skip it.
// @param now The current time, passed in so tests need no clock.
// @returns true when a window closed, whether or not it was worth logging.
func (h *tickHealth) report(log *slog.Logger, now time.Time) bool {
	if h.windowStart.IsZero() {
		h.windowStart = now
		return false
	}
	elapsed := now.Sub(h.windowStart)
	if elapsed < tickHealthWindow {
		return false
	}

	want := int(elapsed.Seconds() * tickTarget)
	if log != nil && want > 0 && float64(h.ticks) < float64(want)*tickHealthFloor {
		log.Warn("bot is ticking below the client rate",
			"ticks", h.ticks,
			"want", want,
			"packets", h.packets,
			"slowestPacket", h.slowestName,
			"slowestMs", h.slowest.Milliseconds(),
			"windowMs", elapsed.Milliseconds(),
		)
	}

	h.windowStart = now
	h.ticks = 0
	h.packets = 0
	h.slowest = 0
	h.slowestName = ""
	return true
}

// packetName returns a readable name for a packet.
//
// @param pk The packet to name.
// @returns its Go type, e.g. `*packet.LevelChunk`.
func packetName(pk packet.Packet) string {
	if pk == nil {
		return "nil"
	}
	return fmt.Sprintf("%T", pk)
}
