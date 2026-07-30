package viewer

import (
	"encoding/json"
	"os"
	"path/filepath"
	"strings"
	"testing"

	"github.com/smell-of-curry/go-test-bds/gotestbds/actor"
	"github.com/smell-of-curry/go-test-bds/gotestbds/assets"
)

// keepFormHandler cancels the receive context so LastForm keeps the form
// (same path TestingHandler uses for viewer capture).
type keepFormHandler struct {
	actor.NopHandler
}

func (keepFormHandler) HandleReceiveForm(ctx *actor.Context, _ *actor.Form) {
	ctx.Cancel()
}

func receiveForm(t *testing.T, a *actor.Actor, f *actor.Form) {
	t.Helper()
	a.Handle(keepFormHandler{})
	a.ReceiveForm(f)
	if _, ok := a.LastForm(); !ok {
		t.Fatal("LastForm empty after keepFormHandler")
	}
}

// Live BEH battle move button shape (BattleUtils.addMoveButton): first text
// part carries the b:N_ padded encoding; later parts are translate+with for
// the hover description. Actor.Text keeps the raw JSON when "with" is present.
func TestEncodeUIFormButtonsPreserveBattleMovePrefix(t *testing.T) {
	moveText := `{"rawtext":[{"text":"b:1_` + "normal" +
		strings.Repeat("_", 24) + "\u00a0." + "growl" + strings.Repeat("_", 25) +
		"\u00a040/40" + strings.Repeat("_", 25) + `"},` +
		`{"text":"§l"},{"translate":"showdown.moves.growl.name"},` +
		`{"text":"§r\n"},{"translate":"forms.battle.moveButton.label.accuracy","with":["100"]},` +
		`{"text":"\n"},{"translate":"showdown.moves.growl.shortDesc"}]}`

	payload := map[string]any{
		"type":    "form",
		"title":   "§b§a§t§l§e§s§m",
		"content": "Turn 1",
		"buttons": []any{
			map[string]any{
				"text": json.RawMessage(moveText),
				"image": map[string]string{
					"type": "path",
					"data": "t__20",
				},
			},
			map[string]any{
				"text": "battleButton:bagBag",
				"image": map[string]string{
					"type": "path",
					"data": "t",
				},
			},
		},
	}
	raw, err := json.Marshal(payload)
	if err != nil {
		t.Fatal(err)
	}

	// Re-marshal with text as embedded JSON object (not a string).
	var wire map[string]any
	if err := json.Unmarshal(raw, &wire); err != nil {
		t.Fatal(err)
	}
	buttons := wire["buttons"].([]any)
	b0 := buttons[0].(map[string]any)
	var moveObj any
	if err := json.Unmarshal([]byte(moveText), &moveObj); err != nil {
		t.Fatal(err)
	}
	b0["text"] = moveObj
	raw, err = json.Marshal(wire)
	if err != nil {
		t.Fatal(err)
	}

	f, err := actor.NewForm(raw, 1, nil)
	if err != nil {
		t.Fatal(err)
	}
	a := testActor(t, "FormBot")
	receiveForm(t, a, f)

	ui := newEncoder("FormBot", 4, 4).encodeUI(a)
	if ui.Form == nil {
		t.Fatal("form missing")
	}
	if len(ui.Form.Buttons) != 2 {
		t.Fatalf("buttons=%d want 2; buttons=%v", len(ui.Form.Buttons), ui.Form.Buttons)
	}
	if !strings.Contains(ui.Form.Buttons[0], "b:1_") {
		t.Fatalf("move button lost b:1_ prefix: %q", ui.Form.Buttons[0])
	}
	if ui.Form.ButtonImages == nil || ui.Form.ButtonImages[0] != "t__20" {
		t.Fatalf("buttonImages=%v", ui.Form.ButtonImages)
	}
	t.Logf("move button wire text (%d chars): %q", len(ui.Form.Buttons[0]), ui.Form.Buttons[0])
}

// Live move buttons carry translate keys in the hover/rawtext tail. With a
// pack lang table installed, flattenRawtext must resolve them (Growl) while
// keeping the b:N_ prefix the JSON UI pack parses for the on-button label.
func TestEncodeUIFormButtonsResolveMoveTranslateWithLang(t *testing.T) {
	dir := t.TempDir()
	writeMoveLangPack(t, dir)
	st, err := assets.BuildStack([]assets.StackEntry{{ID: "moves", Dir: dir}}, 5)
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { activeLang.Store(nil) })
	installLangTable(st)

	moveText := `{"rawtext":[{"text":"b:1_` + "normal" +
		strings.Repeat("_", 24) + "\u00a0." + "growl" + strings.Repeat("_", 25) +
		"\u00a040/40" + strings.Repeat("_", 25) + `"},` +
		`{"text":"§l"},{"translate":"showdown.moves.growl.name"},` +
		`{"text":"§r\n"},{"translate":"showdown.moves.growl.shortDesc"}]}`

	var moveObj any
	if err := json.Unmarshal([]byte(moveText), &moveObj); err != nil {
		t.Fatal(err)
	}
	payload := map[string]any{
		"type":    "form",
		"title":   "§b§a§t§l§e§s§m",
		"content": "Turn 1",
		"buttons": []any{
			map[string]any{
				"text":  moveObj,
				"image": map[string]string{"type": "path", "data": "t__20"},
			},
		},
	}
	raw, err := json.Marshal(payload)
	if err != nil {
		t.Fatal(err)
	}

	f, err := actor.NewForm(raw, 1, nil)
	if err != nil {
		t.Fatal(err)
	}
	a := testActor(t, "FormBot")
	receiveForm(t, a, f)
	ui := newEncoder("FormBot", 4, 4).encodeUI(a)
	if ui.Form == nil || len(ui.Form.Buttons) != 1 {
		t.Fatalf("form=%v", ui.Form)
	}
	got := ui.Form.Buttons[0]
	if !strings.Contains(got, "b:1_") {
		t.Fatalf("lost b:1_ prefix: %q", got)
	}
	if !strings.Contains(got, "Growl") {
		t.Fatalf("translate key not resolved via lang table: %q", got)
	}
	if strings.Contains(got, "showdown.moves.growl.name") {
		t.Fatalf("raw lang key leaked into button text: %q", got)
	}
}

func writeMoveLangPack(t *testing.T, dir string) {
	t.Helper()
	manifest := `{
  "format_version": 2,
  "header": {
    "name": "Move Lang",
    "description": "test",
    "uuid": "44444444-4444-4444-4444-444444444444",
    "version": [1, 0, 0],
    "min_engine_version": [1, 20, 0]
  },
  "modules": [
    {"type": "resources", "uuid": "44444444-4444-4444-4444-444444444445", "version": [1, 0, 0]}
  ]
}`
	if err := os.WriteFile(filepath.Join(dir, "manifest.json"), []byte(manifest), 0o644); err != nil {
		t.Fatal(err)
	}
	if err := os.MkdirAll(filepath.Join(dir, "texts"), 0o755); err != nil {
		t.Fatal(err)
	}
	lang := "showdown.moves.growl.name=Growl\nshowdown.moves.growl.shortDesc=Lowers Attack.\n"
	if err := os.WriteFile(filepath.Join(dir, "texts", "en_US.lang"), []byte(lang), 0o644); err != nil {
		t.Fatal(err)
	}
}

func TestEncodeUIFormButtonsStarterPickerShape(t *testing.T) {
	buttons := make([]any, 0, 36)
	for i := 0; i < 30; i++ {
		buttons = append(buttons, map[string]any{
			"text": "§lMon" + string(rune('A'+i%26)) + "§r\n§7No. 00" + string(rune('1'+i%9)),
			"image": map[string]string{
				"type": "path",
				"data": "textures/sprites/bulbasaur",
			},
		})
	}
	// Fillers + nav row (page 0: no back).
	for i := 0; i < 5; i++ {
		buttons = append(buttons, map[string]any{"text": ""})
	}
	buttons = append(buttons, map[string]any{
		"text": map[string]any{
			"rawtext": []any{map[string]string{"translate": "common.nextPage"}},
		},
		"image": map[string]string{"type": "path", "data": "textures/ui/arrow_right"},
	})

	payload := map[string]any{
		"type":    "form",
		"title":   "§p§o§k§e§1",
		"content": "",
		"buttons": buttons,
	}
	raw, err := json.Marshal(payload)
	if err != nil {
		t.Fatal(err)
	}
	f, err := actor.NewForm(raw, 1, nil)
	if err != nil {
		t.Fatal(err)
	}
	a := testActor(t, "FormBot")
	receiveForm(t, a, f)
	ui := newEncoder("FormBot", 4, 4).encodeUI(a)
	if ui.Form == nil {
		t.Fatal("missing form")
	}
	if len(ui.Form.Buttons) != 36 {
		t.Fatalf("buttons=%d want 36", len(ui.Form.Buttons))
	}
	if ui.Form.Title != "§p§o§k§e§1" {
		t.Fatalf("title=%q", ui.Form.Title)
	}
	empty := 0
	for _, b := range ui.Form.Buttons {
		if b == "" {
			empty++
		}
	}
	if empty < 4 {
		t.Fatalf("expected filler empties, got empty=%d sample=%q", empty, ui.Form.Buttons[30])
	}
	if got := ui.Form.Buttons[35]; !strings.Contains(got, "common.nextPage") && got != "common.nextPage" {
		t.Logf("next page button=%q", got)
	}
	if len(ui.Form.ButtonImages) != 36 {
		t.Fatalf("images=%d want 36", len(ui.Form.ButtonImages))
	}
}
