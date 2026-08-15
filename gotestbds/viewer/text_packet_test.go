package viewer

import (
	"testing"

	"github.com/sandertv/gophertunnel/minecraft/protocol/packet"
	"github.com/smell-of-curry/go-test-bds/gotestbds/actor"
	"github.com/smell-of-curry/go-test-bds/gotestbds/bot"
)

// recordChatHandler mirrors TestingHandler's chat path without the instruction
// dispatch: TextHandler → ReceiveMessage → RecordMessage(+Parameters).
type recordChatHandler struct {
	actor.NopHandler
}

func (recordChatHandler) HandleReceiveMessage(a *actor.Actor, msg string, parameters []string) {
	a.RecordMessage(msg, parameters...)
}

// TestTextPacketTranslationRendersInChatLane is the run-41 death-message path:
// packet.Text Type=Translation, Message=lang key, Parameters=[player name] —
// not a rawtext envelope. Parameters must survive to the viewer chat lane.
func TestTextPacketTranslationRendersInChatLane(t *testing.T) {
	installTestLang(t, map[string]string{
		"death.attack.inWall": "%1$s suffocated in a wall",
		"death.attack.mob":    "%1$s was slain by %2$s",
		"entity.zombie.name":  "Zombie",
	})

	a := testActor(t, "TestBot")
	a.Handle(recordChatHandler{})
	err := (bot.TextHandler{}).Handle(&packet.Text{
		TextType:   packet.TextTypeTranslation,
		Message:    "death.attack.inWall",
		Parameters: []string{"TestBot"},
	}, nil, a)
	if err != nil {
		t.Fatal(err)
	}

	ui := newEncoder("TestBot", 4, 4).encodeUI(a)
	if len(ui.Messages) != 1 {
		t.Fatalf("messages=%v", ui.Messages)
	}
	if ui.Messages[0] != "TestBot suffocated in a wall" {
		t.Fatalf("got %q, want resolved death message", ui.Messages[0])
	}

	// Nested parameter that is itself a translate key (one resolve level).
	a2 := testActor(t, "TestBot")
	a2.Handle(recordChatHandler{})
	_ = (bot.TextHandler{}).Handle(&packet.Text{
		TextType:   packet.TextTypeTranslation,
		Message:    "death.attack.mob",
		Parameters: []string{"TestBot", "entity.zombie.name"},
	}, nil, a2)
	ui2 := newEncoder("TestBot", 4, 4).encodeUI(a2)
	if len(ui2.Messages) != 1 || ui2.Messages[0] != "TestBot was slain by Zombie" {
		t.Fatalf("nested param: %v", ui2.Messages)
	}
}
