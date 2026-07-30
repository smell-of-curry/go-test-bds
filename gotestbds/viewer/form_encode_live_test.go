package viewer

import (
	"encoding/json"
	"strings"
	"testing"

	"github.com/smell-of-curry/go-test-bds/gotestbds/actor"
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
