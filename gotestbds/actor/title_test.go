package actor

import (
	"testing"

	"github.com/sandertv/gophertunnel/minecraft"
	"github.com/sandertv/gophertunnel/minecraft/protocol/login"
	"github.com/sandertv/gophertunnel/minecraft/protocol/packet"
)

type titleStubConn struct{}

func (titleStubConn) IdentityData() login.IdentityData {
	return login.IdentityData{
		Identity:    "00000000-0000-0000-0000-000000000001",
		DisplayName: "TitleBot",
	}
}
func (titleStubConn) WritePacket(packet.Packet) error { return nil }
func (titleStubConn) GameData() minecraft.GameData {
	return minecraft.GameData{EntityRuntimeID: 1, EntityUniqueID: 1, ChunkRadius: 4}
}

func TestApplyTitleActionSetAndClear(t *testing.T) {
	a := Config{Conn: titleStubConn{}}.New()
	a.ApplyTitleAction(packet.TitleActionSetDurations, "", 5, 40, 10)
	a.ApplyTitleAction(packet.TitleActionSetTitle, "Hello", 0, 0, 0)
	a.ApplyTitleAction(packet.TitleActionSetSubtitle, "World", 0, 0, 0)
	a.ApplyTitleAction(packet.TitleActionSetActionBar, "bar", 0, 0, 0)

	got := a.ScreenTitle()
	if got.Title != "Hello" || got.Subtitle != "World" || got.ActionBar != "bar" {
		t.Fatalf("texts = %+v", got)
	}
	if got.FadeInTicks != 5 || got.StayTicks != 40 || got.FadeOutTicks != 10 {
		t.Fatalf("timings = %+v", got)
	}
	seq := got.Seq

	a.ApplyTitleAction(packet.TitleActionClear, "", 0, 0, 0)
	got = a.ScreenTitle()
	if got.Title != "" || got.Subtitle != "" || got.ActionBar != "" {
		t.Fatalf("clear left texts: %+v", got)
	}
	if got.Seq <= seq {
		t.Fatalf("seq did not advance: %d → %d", seq, got.Seq)
	}
}

// Advancing the phud cursor to TitleWriteSeq() (live tip) races writes that
// land between the drain and the cursor bump — those writes are skipped forever.
// TitleWritesFromSeq returns the max seq in the batch so the next drain sees them.
func TestTitleWritesFromSeqCursorStopsAtBatch(t *testing.T) {
	a := Config{Conn: titleStubConn{}}.New()
	a.ApplyTitleAction(packet.TitleActionSetTitle, "&_sidebar:a", 0, 0, 0)
	a.ApplyTitleAction(packet.TitleActionSetTitle, "&_loadingScreen:DONE", 0, 0, 0)

	writes, last := a.TitleWritesFromSeq(0)
	if len(writes) != 2 {
		t.Fatalf("batch len = %d, want 2: %v", len(writes), writes)
	}
	if last != 2 {
		t.Fatalf("last = %d, want 2", last)
	}
	if writes[1] != "&_loadingScreen:DONE" {
		t.Fatalf("writes[1] = %q", writes[1])
	}

	// New write arrives after drain (same race window as stream.go used to have).
	a.ApplyTitleAction(packet.TitleActionSetTitle, "&_sidebar:b", 0, 0, 0)
	if tip := a.TitleWriteSeq(); tip != 3 {
		t.Fatalf("tip = %d, want 3", tip)
	}
	// Cursor at batch max (2), not tip (3) — sidebar:b must still be visible.
	writes2, last2 := a.TitleWritesFromSeq(last)
	if len(writes2) != 1 || writes2[0] != "&_sidebar:b" {
		t.Fatalf("missed raced write: %v (last=%d)", writes2, last2)
	}
	if last2 != 3 {
		t.Fatalf("last2 = %d, want 3", last2)
	}

	// Empty drain leaves cursor unchanged.
	empty, last3 := a.TitleWritesFromSeq(last2)
	if len(empty) != 0 || last3 != last2 {
		t.Fatalf("empty drain moved cursor: empty=%v last=%d", empty, last3)
	}
}
