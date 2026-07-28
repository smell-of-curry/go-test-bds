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
