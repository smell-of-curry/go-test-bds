package bot

import (
	"bytes"
	"log/slog"
	"strings"
	"testing"
	"time"

	"github.com/sandertv/gophertunnel/minecraft/protocol/packet"
)

// TestTickHealthReportsStarvation covers the case the measurement exists for: a
// window where packet handling ate most of the ticks the loop should have run.
func TestTickHealthReportsStarvation(t *testing.T) {
	var buf bytes.Buffer
	log := slog.New(slog.NewTextHandler(&buf, &slog.HandlerOptions{Level: slog.LevelWarn}))

	start := time.Now()
	var h tickHealth
	if h.report(log, start) {
		t.Fatal("the first report only opens the window")
	}

	// A run observed on a live server: 5 s of wall clock, 17 ticks instead of 100.
	for i := 0; i < 17; i++ {
		h.tick()
	}
	h.packet(&packet.LevelChunk{}, 290*time.Millisecond)
	h.packet(&packet.Text{}, time.Millisecond)

	if !h.report(log, start.Add(tickHealthWindow)) {
		t.Fatal("a window that has elapsed should close")
	}

	out := buf.String()
	if !strings.Contains(out, "ticking below the client rate") {
		t.Fatalf("no warning logged: %q", out)
	}
	if !strings.Contains(out, "packet.LevelChunk") {
		t.Fatalf("warning does not name the slowest packet: %q", out)
	}
	if !strings.Contains(out, "slowestMs=290") {
		t.Fatalf("warning does not carry the cost: %q", out)
	}
	if h.ticks != 0 || h.packets != 0 || h.slowest != 0 {
		t.Fatalf("window not reset: ticks=%d packets=%d slowest=%s",
			h.ticks, h.packets, h.slowest)
	}
}

// TestTickHealthQuietWhenKeepingUp guards the other half: a loop at rate must not
// log, or the line becomes noise nobody reads.
func TestTickHealthQuietWhenKeepingUp(t *testing.T) {
	var buf bytes.Buffer
	log := slog.New(slog.NewTextHandler(&buf, &slog.HandlerOptions{Level: slog.LevelWarn}))

	start := time.Now()
	var h tickHealth
	h.report(log, start)
	for i := 0; i < tickTarget*int(tickHealthWindow/time.Second); i++ {
		h.tick()
	}
	h.report(log, start.Add(tickHealthWindow))

	if buf.Len() != 0 {
		t.Fatalf("logged while keeping up: %q", buf.String())
	}
}
