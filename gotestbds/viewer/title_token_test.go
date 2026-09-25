package viewer

import (
	"encoding/json"
	"os"
	"path/filepath"
	"testing"

	"github.com/sandertv/gophertunnel/minecraft/protocol/packet"
)

func TestTitleTokenPrefixFromManifest(t *testing.T) {
	dir := t.TempDir()
	body := []byte(`{"modules":[],"bot":{"titleTokenPrefix":"@@"}}`)
	if err := os.WriteFile(filepath.Join(dir, "manifest.json"), body, 0o644); err != nil {
		t.Fatal(err)
	}
	if got := titleTokenPrefixFromManifest(dir); got != "@@" {
		t.Fatalf("prefix=%q", got)
	}
	hub, err := New(Options{
		EncodeEveryTick: true,
		Address:         "127.0.0.1:0",
		ArtifactDir:     t.TempDir(),
		ExtensionsDir:   dir,
	})
	if err != nil {
		t.Fatal(err)
	}
	defer hub.Close()
	if hub.opts.TitleTokenPrefix != "@@" {
		t.Fatalf("hub prefix=%q", hub.opts.TitleTokenPrefix)
	}
	explicit, err := New(Options{
		EncodeEveryTick:  true,
		Address:          "127.0.0.1:0",
		ArtifactDir:      t.TempDir(),
		ExtensionsDir:    dir,
		TitleTokenPrefix: "^^",
	})
	if err != nil {
		t.Fatal(err)
	}
	defer explicit.Close()
	if explicit.opts.TitleTokenPrefix != "^^" {
		t.Fatalf("explicit prefix=%q", explicit.opts.TitleTokenPrefix)
	}
}

func testTokenHub(t *testing.T) *Hub {
	t.Helper()
	hub, err := New(Options{
		EncodeEveryTick:  true,
		Address:          "127.0.0.1:0",
		ArtifactDir:      t.TempDir(),
		TitleTokenPrefix: "&_",
	})
	if err != nil {
		t.Fatal(err)
	}
	return hub
}

func TestParseTitleToken(t *testing.T) {
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
		token, value, ok := parseTitleToken(c.in, "&_")
		if token != c.token || value != c.value || ok != c.ok {
			t.Fatalf("parseTitleToken(%q) = (%q, %q, %v), want (%q, %q, %v)",
				c.in, token, value, ok, c.token, c.value, c.ok)
		}
	}
	if token, value, ok := parseTitleToken("&_sidebar:a", ""); ok || token != "" || value != "" {
		t.Fatalf("empty prefix parsed (%q, %q, %v)", token, value, ok)
	}
}

// Every prefixed write between stream ticks must emit its own titleToken
// frame — feeders write several tokens per tick and the latest-state title
// snapshot keeps only the last one.
func TestTitleTokenLaneEmitsEveryWrite(t *testing.T) {
	hub := testTokenHub(t)
	defer hub.Close()

	s := hub.Register("HudBot")
	sub := s.attach()
	defer s.detach(sub)

	a := testActor(t, "HudBot")
	s.Tick(a)
	if fr, ok := sub.next(); !ok || fr.event != "keyframe" {
		t.Fatalf("want opening keyframe, got %+v ok=%v", fr, ok)
	}

	// Three token writes plus one plain title in the same tick.
	a.ApplyTitleAction(packet.TitleActionSetTitle, "&_playerPing:§a63", 0, 0, 0)
	a.ApplyTitleAction(packet.TitleActionSetTitle, "&_currency:"+"tip text", 0, 0, 0)
	a.ApplyTitleAction(packet.TitleActionSetTitle, "&_sidebar:a|b|c", 0, 0, 0)
	a.ApplyTitleAction(packet.TitleActionSetTitle, "Level Up!", 0, 0, 0)
	s.Tick(a)

	var tokens []TitleTokenFrame
	var titles []TitleFrame
	for {
		fr, ok := sub.next()
		if !ok {
			break
		}
		switch fr.event {
		case "titleToken":
			var pf TitleTokenFrame
			if err := json.Unmarshal(fr.data, &pf); err != nil {
				t.Fatal(err)
			}
			tokens = append(tokens, pf)
		case "title":
			var tf TitleFrame
			if err := json.Unmarshal(fr.data, &tf); err != nil {
				t.Fatal(err)
			}
			titles = append(titles, tf)
		}
	}

	if len(tokens) != 3 {
		t.Fatalf("titleToken frames = %+v, want 3", tokens)
	}
	want := []struct{ token, value string }{
		{"playerPing", "§a63"},
		{"currency", "tip text"},
		{"sidebar", "a|b|c"},
	}
	for i, w := range want {
		if tokens[i].Token != w.token || tokens[i].Value != w.value {
			t.Fatalf("titleToken[%d] = %+v, want %+v", i, tokens[i], w)
		}
		if tokens[i].Type != "titleToken" || tokens[i].V != SchemaVersion {
			t.Fatalf("titleToken[%d] envelope = %+v", i, tokens[i])
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
		if fr.event == "titleToken" {
			t.Fatalf("duplicate titleToken frame after cursor advance: %s", fr.data)
		}
	}
}

// Keyframe/attach must replay the latest title-token map — EventSource
// reconnect otherwise paints an empty HUD until the next live write.
func TestTitleTokenReplayOnKeyframeAttach(t *testing.T) {
	hub := testTokenHub(t)
	defer hub.Close()

	s := hub.Register("HudBot")
	sub := s.attach()
	defer s.detach(sub)

	a := testActor(t, "HudBot")
	s.Tick(a)
	if fr, ok := sub.next(); !ok || fr.event != "keyframe" {
		t.Fatalf("want opening keyframe, got %+v ok=%v", fr, ok)
	}

	card := "&_loadingScreen:§l§6TUTORIAL COMPLETE!\n\n§eWelcome"
	a.ApplyTitleAction(packet.TitleActionSetTitle, card, 0, 0, 0)
	a.ApplyTitleAction(packet.TitleActionSetTitle, "&_sidebar:party", 0, 0, 0)
	s.Tick(a)
	for {
		if _, ok := sub.next(); !ok {
			break
		}
	}

	sub2 := s.attach()
	defer s.detach(sub2)
	s.Tick(a)
	if fr, ok := sub2.next(); !ok || fr.event != "keyframe" {
		t.Fatalf("second attach keyframe = %+v ok=%v", fr, ok)
	}

	got := map[string]string{}
	for {
		fr, ok := sub2.next()
		if !ok {
			break
		}
		if fr.event != "titleToken" {
			continue
		}
		var pf TitleTokenFrame
		if err := json.Unmarshal(fr.data, &pf); err != nil {
			t.Fatal(err)
		}
		got[pf.Token] = pf.Value
	}
	if got["loadingScreen"] != "§l§6TUTORIAL COMPLETE!\n\n§eWelcome" {
		t.Fatalf("replay loadingScreen = %q, want completion card", got["loadingScreen"])
	}
	if got["sidebar"] != "party" {
		t.Fatalf("replay sidebar = %q", got["sidebar"])
	}
}

// A rawtext-wrapped control token must flatten, parse, and lang-resolve
// like the other lanes.
func TestTitleTokenLaneFlattensRawtext(t *testing.T) {
	hub := testTokenHub(t)
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

	var got *TitleTokenFrame
	for {
		fr, ok := sub.next()
		if !ok {
			break
		}
		if fr.event != "titleToken" {
			continue
		}
		var pf TitleTokenFrame
		if err := json.Unmarshal(fr.data, &pf); err != nil {
			t.Fatal(err)
		}
		got = &pf
	}
	if got == nil {
		t.Fatal("no titleToken frame emitted for rawtext-wrapped token")
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
