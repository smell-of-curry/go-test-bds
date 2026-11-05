package viewer

import (
	"context"
	"encoding/json"
	"os"
	"path/filepath"
	"testing"

	"github.com/google/uuid"
	"github.com/sandertv/gophertunnel/minecraft/protocol"
	"github.com/sandertv/gophertunnel/minecraft/protocol/packet"
	"github.com/smell-of-curry/go-test-bds/gotestbds/actor"
	"github.com/smell-of-curry/go-test-bds/gotestbds/assets"
)

// A recorder subscribes internally, without HTTP. Server packs can arrive
// after registration; the next tick must localize forms and event-lane text
// before rawtext arguments are flattened irreversibly into the SSE recording.
func TestHeadlessRecorderRefreshesLanguageAfterPackIngest(t *testing.T) {
	activeLang.Store(nil)
	t.Cleanup(func() { activeLang.Store(nil) })
	cache := t.TempDir()
	mgr, err := assets.New(context.Background(), assets.Options{
		CacheDir: cache, BaselineTag: "v1.26.30.5",
		Fetcher: copyFetcher{src: filepath.Join("..", "assets", "testdata", "samples")},
	})
	if err != nil {
		t.Fatal(err)
	}
	dir := t.TempDir()
	hub, err := New(Options{
		Address: "127.0.0.1:0", ArtifactDir: t.TempDir(), RecordDir: dir,
		Assets: mgr, EncodeEveryTick: true, TitleTokenPrefix: "&_",
	})
	if err != nil {
		t.Fatal(err)
	}
	defer hub.Close()
	s := hub.Register("Cam")
	a := testActor(t, "Cam")
	s.Tick(a) // The recorder is running with only the baseline pack.

	packDir := t.TempDir()
	writeLangPack(t, packDir)
	packCache := assets.Cache{Root: cache}
	if _, err := packCache.PutDirectory(
		uuid.MustParse("33333333-3333-3333-3333-333333333333"), "1.0.0", packDir,
	); err != nil {
		t.Fatal(err)
	}
	mgr.SetStackOrder([]protocol.StackResourcePack{{
		UUID: "33333333-3333-3333-3333-333333333333", Version: "1.0.0",
	}})
	if err := mgr.IngestServerPacks(nil); err != nil {
		t.Fatal(err)
	}
	const rawtext = `{"rawtext":[{"translate":"models.showdown.switch.actorSentOut","with":["Cam","Bulbasaur"]}]}`
	const want = "Cam sent out Bulbasaur!"
	a.RecordMessage("models.showdown.switch.actorSentOut", "Cam", "Bulbasaur")
	a.ApplyTitleAction(packet.TitleActionSetTitle, "&_battleWait:"+rawtext, 0, 0, 0)
	form, err := actor.NewForm([]byte(`{"type":"form","title":"Battle","content":"","buttons":[{"text":`+rawtext+`}]}`), 1, nil)
	if err != nil {
		t.Fatal(err)
	}
	receiveForm(t, a, form)
	s.Tick(a)
	if err := hub.Close(); err != nil {
		t.Fatal(err)
	}
	raw, err := os.ReadFile(filepath.Join(dir, "Cam.sse"))
	if err != nil {
		t.Fatal(err)
	}
	var sawChat, sawToken, sawForm bool
	for _, frame := range splitSSE(t, raw) {
		var data struct {
			Text  string `json:"text"`
			Token string `json:"token"`
			Value string `json:"value"`
			UI    *UI    `json:"ui"`
		}
		if err := json.Unmarshal(frame.data, &data); err != nil {
			t.Fatal(err)
		}
		if frame.event == "chat" && data.Text == want {
			sawChat = true
		}
		if frame.event == "titleToken" && data.Token == "battleWait" && data.Value == want {
			sawToken = true
		}
		if data.UI != nil && data.UI.Form != nil && len(data.UI.Form.Buttons) == 1 && data.UI.Form.Buttons[0] == want {
			sawForm = true
		}
	}
	if !sawChat || !sawToken || !sawForm {
		t.Fatalf("headless recording localized chat=%v token=%v form=%v; SSE:\n%s", sawChat, sawToken, sawForm, raw)
	}
}
