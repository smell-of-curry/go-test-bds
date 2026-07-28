package bot

import (
	"fmt"
	"log/slog"
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
}

// tick records one simulated tick.
func (h *tickHealth) tick() {
	h.ticks++
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
