package viewer

import (
	"encoding/json"
	"testing"

	"github.com/sandertv/gophertunnel/minecraft/protocol/packet"
)

func TestParsePhudToken(t *testing.T) {
	cases := []struct {
		in    string
		token string
		value string
		ok    bool
	}{
		{"&_currency:msg____ 1.00K", "currency", "msg____ 1.00K", true},
		{"&_sidebar:HP: 20/20|||x", "sidebar", "HP: 20/20|||x", true},
		{"&_playerPing:§a63", "playerPing", "§a63", true},
		{"&_phone:", "phone", "", true},
		// Values may contain further colons; only the first splits.
		{"&_battleWait:Turn: 1", "battleWait", "Turn: 1", true},
		{"&_nocolon", "", "", false},
		{"plain title", "", "", false},
		{"", "", "", false},
	}
	for _, c := range cases {
		token, value, ok := parsePhudToken(c.in)
		if token != c.token || value != c.value || ok != c.ok {
			t.Fatalf("parsePhudToken(%q) = (%q, %q, %v), want (%q, %q, %v)",
				c.in, token, value, ok, c.token, c.value, c.ok)
		}
	}
}

// Every PHUD write between stream ticks must emit its own phud frame — the
// feeders write several tokens per tick (sidebar, currency, ping) and the
// latest-state title snapshot keeps only the last one.
func TestPhudLaneEmitsEveryTokenWrite(t *testing.T) {
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

	// Three PHUD writes plus one plain title in the same tick.
	a.ApplyTitleAction(packet.TitleActionSetTitle, "&_playerPing:§a63", 0, 0, 0)
	a.ApplyTitleAction(packet.TitleActionSetTitle, "&_currency:"+"tip text", 0, 0, 0)
	a.ApplyTitleAction(packet.TitleActionSetTitle, "&_sidebar:a|b|c", 0, 0, 0)
	a.ApplyTitleAction(packet.TitleActionSetTitle, "Level Up!", 0, 0, 0)
	s.Tick(a)

	var phud []PhudFrame
	var titles []TitleFrame
	for {
		fr, ok := sub.next()
		if !ok {
			break
		}
		switch fr.event {
		case "phud":
			var pf PhudFrame
			if err := json.Unmarshal(fr.data, &pf); err != nil {
				t.Fatal(err)
			}
			phud = append(phud, pf)
		case "title":
			var tf TitleFrame
			if err := json.Unmarshal(fr.data, &tf); err != nil {
				t.Fatal(err)
			}
			titles = append(titles, tf)
		}
	}

	if len(phud) != 3 {
		t.Fatalf("phud frames = %+v, want 3", phud)
	}
	want := []struct{ token, value string }{
		{"playerPing", "§a63"},
		{"currency", "tip text"},
		{"sidebar", "a|b|c"},
	}
	for i, w := range want {
		if phud[i].Token != w.token || phud[i].Value != w.value {
			t.Fatalf("phud[%d] = %+v, want %+v", i, phud[i], w)
		}
		if phud[i].Type != "phud" || phud[i].V != SchemaVersion {
			t.Fatalf("phud[%d] envelope = %+v", i, phud[i])
		}
	}

	// The filtered title lane is unchanged: the plain title still arrives,
	// and no raw "&_" text leaks onto it.
	if len(titles) != 1 || titles[0].Title != "Level Up!" {
		t.Fatalf("titles = %+v, want the single plain title", titles)
	}

	// A later tick with no new writes emits nothing (cursor advanced).
	s.Tick(a)
	for {
		fr, ok := sub.next()
		if !ok {
			break
		}
		if fr.event == "phud" {
			t.Fatalf("duplicate phud frame after cursor advance: %s", fr.data)
		}
	}
}

// The rawtext-wrapped form (battle log rides "&_battleWait:" inside a rawtext
// envelope) must flatten, parse, and lang-resolve like the other lanes.
func TestPhudLaneFlattensRawtext(t *testing.T) {
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

	wire := `{"rawtext":[{"text":"&_battleWait:"},{"translate":"models.showdown.move.used","with":{"rawtext":[{"text":"Bulbasaur"},{"text":"Growl"}]}}]}`
	a.ApplyTitleAction(packet.TitleActionSetTitle, wire, 0, 0, 0)
	s.Tick(a)

	var got *PhudFrame
	for {
		fr, ok := sub.next()
		if !ok {
			break
		}
		if fr.event != "phud" {
			continue
		}
		var pf PhudFrame
		if err := json.Unmarshal(fr.data, &pf); err != nil {
			t.Fatal(err)
		}
		got = &pf
	}
	if got == nil {
		t.Fatal("no phud frame emitted for rawtext-wrapped token")
	}
	if got.Token != "battleWait" {
		t.Fatalf("token = %q", got.Token)
	}
	if got.Value != "models.showdown.move.used Bulbasaur Growl" {
		t.Fatalf("value = %q", got.Value)
	}
}

// FormHover fans one formHover frame to the bot's subscribers and no-ops for
// unknown bots.
func TestFormHoverEmits(t *testing.T) {
	hub, err := New(Options{EncodeEveryTick: true, Address: "127.0.0.1:0", ArtifactDir: t.TempDir()})
	if err != nil {
		t.Fatal(err)
	}
	defer hub.Close()

	s := hub.Register("HudBot")
	sub := s.attach()
	defer s.detach(sub)

	hub.FormHover("NoSuchBot", 1) // must not panic
	hub.FormHover("HudBot", 2)

	fr, ok := sub.next()
	if !ok || fr.event != "formHover" {
		t.Fatalf("frame = %+v ok=%v, want formHover", fr, ok)
	}
	var hf FormHoverFrame
	if err := json.Unmarshal(fr.data, &hf); err != nil {
		t.Fatal(err)
	}
	if hf.Index != 2 || hf.Type != "formHover" || hf.Bot != "HudBot" {
		t.Fatalf("formHover = %+v", hf)
	}
}
