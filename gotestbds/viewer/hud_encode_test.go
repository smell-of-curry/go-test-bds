package viewer

import (
	"encoding/json"
	"testing"

	"github.com/sandertv/gophertunnel/minecraft/protocol/packet"
)

func TestEncodeUIFiltersProtocolChatNoise(t *testing.T) {
	a := testActor(t, "HudBot")
	a.RecordMessage("§aWelcome")
	a.RecordMessage("[RUN_ACTION]{\"action\":\"jump\"}")
	a.RecordMessage("[STATUS]{\"status\":\"ok\"}")
	a.RecordMessage("[GOTESTBDS]{\"kind\":\"testEnd\"}")
	a.RecordMessage("real chat")

	ui := newEncoder("HudBot", 4, 4).encodeUI(a)
	if len(ui.Messages) != 2 {
		t.Fatalf("messages=%v want 2 player-facing lines", ui.Messages)
	}
	if ui.Messages[0] != "§aWelcome" || ui.Messages[1] != "real chat" {
		t.Fatalf("messages=%v", ui.Messages)
	}
}

func TestFlattenRawtext(t *testing.T) {
	// The battle sidebar title as PokeBedrock actually sends it: translate
	// keys with nested-rawtext "with" args, mixed with plain text parts.
	battle := `{"rawtext":[{"translate":"models.player.battleSide.turn","with":{"rawtext":[{"text":"18"}]}},{"text":"\n\n"},{"translate":"models.player.battleSide.noTerrain"}]}`
	got := flattenRawtext(battle)
	want := "models.player.battleSide.turn 18\n\nmodels.player.battleSide.noTerrain"
	if got != want {
		t.Fatalf("flattenRawtext=%q want %q", got, want)
	}

	if got := flattenRawtext(`{"rawtext":[{"translate":"a.key","with":["x","y"]}]}`); got != "a.key x y" {
		t.Fatalf("plain with args=%q", got)
	}

	// Non-rawtext input must pass through untouched, including plain JSON.
	for _, passthrough := range []string{"plain title", `{"not":"rawtext"}`, ""} {
		if got := flattenRawtext(passthrough); got != passthrough {
			t.Fatalf("flattenRawtext(%q)=%q want unchanged", passthrough, got)
		}
	}

	// The envelope must flatten even when text precedes it — run 14's finale
	// subtitle arrived with a prefix and stayed a JSON wall on screen.
	prefixed := "§aphone:\n" + `{"rawtext":[{"translate":"a.key"}]}` + " tail"
	if got := flattenRawtext(prefixed); got != "§aphone:\na.key tail" {
		t.Fatalf("prefixed=%q", got)
	}
}

func TestFilterHudControlText(t *testing.T) {
	cases := map[string]string{
		// Display-worthy PHUD tokens surface their value.
		"&_loadingScreen:§l§6TUTORIAL COMPLETE!": "§l§6TUTORIAL COMPLETE!",
		"&_currency:Go see Professor Oak":        "Go see Professor Oak",
		"&_battleWait:Bulbasaur used Growl":      "Bulbasaur used Growl",
		// Control-state tokens vanish.
		"&_phone:ring":       "",
		"&_phone:":           "",
		"&_sidebar:HP: 20|…": "",
		"&_playerPing:§a1":   "",
		// Plain text passes through.
		"Level Up!": "Level Up!",
		"":          "",
	}
	for in, want := range cases {
		if got := filterHudControlText(in); got != want {
			t.Fatalf("filterHudControlText(%q)=%q want %q", in, got, want)
		}
	}

	// The rawtext battle-log title as the wire carries it: flatten exposes the
	// token, the filter keeps the log text a real client's battle UI shows.
	wire := `{"rawtext":[{"text":"&_battleWait:"},{"translate":"models.showdown.move.used","with":{"rawtext":[{"text":"Bulbasaur"},{"text":"Growl"}]}}]}`
	got := filterHudControlText(flattenRawtext(wire))
	if got != "models.showdown.move.used Bulbasaur Growl" {
		t.Fatalf("battle log title=%q", got)
	}
}

func TestEncodeUICarriesTitleAndHotbar(t *testing.T) {
	a := testActor(t, "HudBot")
	a.ApplyTitleAction(packet.TitleActionSetDurations, "", 8, 60, 12)
	a.ApplyTitleAction(packet.TitleActionSetTitle, "Level Up!", 0, 0, 0)
	a.ApplyTitleAction(packet.TitleActionSetSubtitle, "Charizard", 0, 0, 0)
	a.ApplyTitleAction(packet.TitleActionSetActionBar, "Press F", 0, 0, 0)

	if err := a.SetHeldSlot(3); err != nil {
		t.Fatal(err)
	}

	enc := newEncoder("HudBot", 4, 4)
	ui := enc.encodeUI(a)
	if ui.Title != "Level Up!" || ui.Subtitle != "Charizard" || ui.ActionBar != "Press F" {
		t.Fatalf("title fields = %+v", ui)
	}
	if ui.FadeInTicks != 8 || ui.StayTicks != 60 || ui.FadeOutTicks != 12 {
		t.Fatalf("fade timings = %+v", ui)
	}

	act := enc.encodeActor(a)
	if act.HeldSlot != 3 {
		t.Fatalf("heldSlot=%d", act.HeldSlot)
	}
	if len(act.Hotbar) != 9 {
		t.Fatalf("hotbar len=%d want 9", len(act.Hotbar))
	}
	// health/food ride actor attributes when the server sends them; the field
	// is always present on the wire even at the zero default.
	_ = act.Health
	_ = act.Food
}

func TestChatAndTitleEventsNeverDropForWorldFrames(t *testing.T) {
	hub, err := New(Options{EncodeEveryTick: true, Address: "127.0.0.1:0", ArtifactDir: t.TempDir()})
	if err != nil {
		t.Fatal(err)
	}
	defer hub.Close()

	s := hub.Register("HudBot")
	sub := s.attach()
	defer s.detach(sub)

	a := testActor(t, "HudBot")
	s.Tick(a)
	if fr, ok := sub.next(); !ok || fr.event != "keyframe" {
		t.Fatalf("want opening keyframe, got %+v ok=%v", fr, ok)
	}

	// Flood unread world frames, then emit chat+title — events must still land.
	for i := 0; i < 5; i++ {
		s.Tick(a)
	}
	a.RecordMessage("§ePing")
	a.ApplyTitleAction(packet.TitleActionSetTitle, "Hi", 0, 0, 0)
	s.Tick(a)

	var sawChat, sawTitle bool
	for {
		fr, ok := sub.next()
		if !ok {
			break
		}
		switch fr.event {
		case "chat":
			var cf ChatFrame
			if err := json.Unmarshal(fr.data, &cf); err != nil {
				t.Fatal(err)
			}
			if cf.Text != "§ePing" {
				t.Fatalf("chat text=%q", cf.Text)
			}
			sawChat = true
		case "title":
			var tf TitleFrame
			if err := json.Unmarshal(fr.data, &tf); err != nil {
				t.Fatal(err)
			}
			if tf.Title != "Hi" {
				t.Fatalf("title=%q", tf.Title)
			}
			sawTitle = true
		}
	}
	if !sawChat || !sawTitle {
		t.Fatalf("sawChat=%v sawTitle=%v", sawChat, sawTitle)
	}
}

func TestProtocolNoiseNeverEmittedAsChatEvent(t *testing.T) {
	hub, err := New(Options{EncodeEveryTick: true, Address: "127.0.0.1:0", ArtifactDir: t.TempDir()})
	if err != nil {
		t.Fatal(err)
	}
	defer hub.Close()

	s := hub.Register("HudBot")
	sub := s.attach()
	defer s.detach(sub)

	a := testActor(t, "HudBot")
	s.Tick(a)
	_, _ = sub.next() // keyframe

	a.RecordMessage("[RUN_ACTION]noise")
	a.RecordMessage("[STATUS]noise")
	a.RecordMessage("[GOTESTBDS]noise")
	a.RecordMessage("ok")
	s.Tick(a)

	var chats []string
	for {
		fr, ok := sub.next()
		if !ok {
			break
		}
		if fr.event != "chat" {
			continue
		}
		var cf ChatFrame
		_ = json.Unmarshal(fr.data, &cf)
		chats = append(chats, cf.Text)
	}
	if len(chats) != 1 || chats[0] != "ok" {
		t.Fatalf("chats=%v", chats)
	}
}
