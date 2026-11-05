package viewer

import (
	"encoding/json"
	"reflect"
	"testing"

	"github.com/smell-of-curry/go-test-bds/gotestbds/actor"
)

func formSnapshot(t *testing.T, payload string) (UIForm, *actor.Form) {
	t.Helper()
	f, err := actor.NewForm([]byte(payload), 1, nil)
	if err != nil {
		t.Fatal(err)
	}
	a := testActor(t, "FormBot")
	receiveForm(t, a, f)
	// Exercise the actual serialized keyframe, including the nested JSON string.
	kf := encodeKeyframe(t, newEncoder("FormBot", 4, 4), a)
	if kf.UI.Form == nil {
		t.Fatal("snapshot has no form")
	}
	return *kf.UI.Form, f
}

func useFormLang(t *testing.T, table map[string]string) {
	t.Helper()
	previous := activeLang.Load()
	activeLang.Store(&table)
	t.Cleanup(func() { activeLang.Store(previous) })
}

// ActionForm's locked RawMessage label is rawJoin(" ", originalLabel), not a
// flat string. Both disabled side actions must retain their authored IDs.
func TestLockedFormButtonsPreserveNestedRawtext(t *testing.T) {
	useFormLang(t, map[string]string{
		"action.bag": "§rOpen the Bag.", "action.run": "§rLeave the battle.",
	})
	const raw = `{"type":"form","title":"Menu","content":"","buttons":[
		{"text":{"rawtext":[{"text":" "},{"rawtext":[{"text":"battleButton:bag"},{"translate":"action.bag"}]}]},"image":{"type":"path","data":"f"}},
		{"text":{"rawtext":[{"text":" "},{"rawtext":[{"text":"battleButton:run"},{"translate":"action.run"}]}]},"image":{"type":"path","data":"f"}}
	]}`
	form, original := formSnapshot(t, raw)
	want := []string{" battleButton:bag§rOpen the Bag.", " battleButton:run§rLeave the battle."}
	if !reflect.DeepEqual(form.Buttons, want) {
		t.Fatalf("buttons=%q, want %q", form.Buttons, want)
	}
	if !reflect.DeepEqual(form.ButtonImages, []string{"f", "f"}) || original.Raw() != raw {
		t.Fatal("disabled image state or original packet changed")
	}
}

// Reduced from the real v6 request: flattening the entire array used to emit
// `"text":Format` and leave the subsequent toggles as rawtext objects.
func TestCustomFormSnapshotLocalizesEachControlAndKeepsValidJSON(t *testing.T) {
	useFormLang(t, map[string]string{
		"forms.player.title.sendBattleRequest":          "Send Battle Request to: %1",
		"forms.player.label.format":                     "Format",
		"forms.player.label.allowBag":                   "Allow Bag",
		"forms.player.label.allowActivePokemonSwapping": "Allow Active Pokemon Swapping",
		"forms.player.label.allowRunning":               "Allow Running",
	})
	const raw = `{"type":"custom_form","title":{"rawtext":[{"translate":"forms.player.title.sendBattleRequest","with":{"rawtext":[{"text":"FilmCam3"}]}}]},"content":[
		{"type":"dropdown","text":{"rawtext":[{"translate":"forms.player.label.format"}]},"options":["Singles","Doubles","[Rated] Singles","[Rated] Doubles","[Rated] Anything Goes","[Rated] Uber"]},
		{"type":"toggle","text":{"rawtext":[{"translate":"forms.player.label.allowBag"}]},"default":true},
		{"type":"toggle","text":{"rawtext":[{"translate":"forms.player.label.allowActivePokemonSwapping"}]},"default":true},
		{"type":"toggle","text":{"rawtext":[{"translate":"forms.player.label.allowRunning"}]},"default":false}
	]}`
	form, f := formSnapshot(t, raw)
	if form.Type != "custom" || form.Title != "Send Battle Request to: FilmCam3" {
		t.Fatalf("unexpected form: %#v", form)
	}
	var got []map[string]any
	if err := json.Unmarshal([]byte(form.Content), &got); err != nil {
		t.Fatalf("custom content is not JSON: %v\n%s", err, form.Content)
	}
	want := []map[string]any{
		{"type": "dropdown", "text": "Format", "options": []any{"Singles", "Doubles", "[Rated] Singles", "[Rated] Doubles", "[Rated] Anything Goes", "[Rated] Uber"}},
		{"type": "toggle", "text": "Allow Bag", "default": true},
		{"type": "toggle", "text": "Allow Active Pokemon Swapping", "default": true},
		{"type": "toggle", "text": "Allow Running", "default": false},
	}
	if !reflect.DeepEqual(got, want) {
		t.Fatalf("content=%#v, want %#v", got, want)
	}
	if f.Raw() != raw {
		t.Fatal("encoding changed the original form payload")
	}
}

func TestCustomFormSnapshotPreservesDefaultsAndLocalizesOptions(t *testing.T) {
	useFormLang(t, map[string]string{
		"ui.name": "Name \"quoted\"\nsecond line", "ui.placeholder": "Type \\ here",
		"ui.option.one": "First", "ui.option.two": "Second", "ui.step.low": "Low", "ui.step.high": "High",
	})
	const controls = `[
		{"type":"label","text":{"rawtext":[{"text":"Literal label"}]}},
		{"type":"input","text":{"rawtext":[{"translate":"ui.name"}]},"placeholder":"ui.placeholder","default":"ui.option.one","metadata":{"rawtext":[{"translate":"ui.option.two"}],"id":9007199254740993}},
		{"type":"dropdown","text":"Choice","options":["ui.option.one","{\"rawtext\":[{\"translate\":\"ui.option.two\"}]}","Literal"],"default":1},
		{"type":"step_slider","text":"Step","steps":["ui.step.low","ui.step.high"],"default":1},
		{"type":"slider","text":"Amount","min":-1.5,"max":10,"step":0.25,"default":0.5},
		{"type":"toggle","text":"Enabled","default":false}
	]`
	for _, field := range []string{"content", "elements"} {
		t.Run(field, func(t *testing.T) {
			raw := `{"type":"custom_form","title":"Settings","` + field + `":` + controls + `}`
			form, f := formSnapshot(t, raw)
			var got []map[string]json.RawMessage
			if err := json.Unmarshal([]byte(form.Content), &got); err != nil {
				t.Fatalf("custom content is not JSON: %v\n%s", err, form.Content)
			}
			var want []map[string]json.RawMessage
			if err := json.Unmarshal([]byte(controls), &want); err != nil {
				t.Fatal(err)
			}
			put := func(i int, key string, value any) { want[i][key], _ = json.Marshal(value) }
			put(0, "text", "Literal label")
			put(1, "text", "Name \"quoted\"\nsecond line")
			put(1, "placeholder", "Type \\ here")
			put(2, "options", []string{"First", "Second", "Literal"})
			put(3, "steps", []string{"Low", "High"})
			if !reflect.DeepEqual(got, want) {
				t.Fatalf("content=%s; wanted localized display fields with all values/metadata unchanged", form.Content)
			}
			c, _ := f.CustomFormContent()
			values := make([]any, len(c.Elements()))
			for i, el := range c.Elements() {
				values[i] = el.ResponseValue()
			}
			if !reflect.DeepEqual(values, []any{nil, "ui.option.one", 1, 1, 0.5, false}) {
				t.Fatalf("encoding changed response defaults: %#v", values)
			}
			if f.Raw() != raw {
				t.Fatal("encoding changed raw payload")
			}
		})
	}
}

func TestModalSnapshotLocalizesDirectRawtextButtons(t *testing.T) {
	useFormLang(t, map[string]string{"ui.continue": "Continue", "ui.dismiss": "Dismiss %1"})
	form, _ := formSnapshot(t, `{"type":"modal","title":"Result","content":"Done",
		"button1":{"rawtext":[{"translate":"ui.continue"}]},
		"button2":{"rawtext":[{"translate":"ui.dismiss","with":["result"]}]}}`)
	if !reflect.DeepEqual(form.Buttons, []string{"Continue", "Dismiss result"}) {
		t.Fatalf("buttons=%q", form.Buttons)
	}
}
