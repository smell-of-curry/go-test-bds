package actor

import (
	"encoding/json"
	"testing"
)

// TestTextAcceptsEveryShapeAServerSends covers the JSON shapes Bedrock allows
// wherever UI text is expected. A localised addon sends rawtext, which used to
// fail to unmarshal and disconnect the bot mid-run.
func TestTextAcceptsEveryShapeAServerSends(t *testing.T) {
	for _, test := range []struct {
		name string
		json string
		want string
	}{
		{name: "plain string", json: `"Choose a starter"`, want: "Choose a starter"},
		{name: "empty string", json: `""`, want: ""},
		{
			name: "literal in a rawtext wrapper",
			json: `{"rawtext":[{"text":"Choose a starter"}]}`,
			want: "Choose a starter",
		},
		{
			// Keep envelopes with translate so viewer lang can resolve
			// (battle move names were stuck as showdown.moves.*.name).
			name: "translation key keeps JSON",
			json: `{"rawtext":[{"translate":"forms.starter.title"}]}`,
			want: `{"rawtext":[{"translate":"forms.starter.title"}]}`,
		},
		{
			name: "concatenated translate parts keep JSON",
			json: `{"rawtext":[{"text":"§l"},{"translate":"forms.starter.title"},{"text":" (1/3)"}]}`,
			want: `{"rawtext":[{"text":"§l"},{"translate":"forms.starter.title"},{"text":" (1/3)"}]}`,
		},
		{
			name: "bare translate object with args keeps its JSON",
			json: `{"translate":"forms.starter.title","with":["Bulbasaur"]}`,
			want: `{"translate":"forms.starter.title","with":["Bulbasaur"]}`,
		},
		{
			name: "translate part with nested rawtext args keeps its JSON",
			json: `{"rawtext":[{"translate":"a.key","with":{"rawtext":[{"text":"100"}]}}]}`,
			want: `{"rawtext":[{"translate":"a.key","with":{"rawtext":[{"text":"100"}]}}]}`,
		},
		{
			name: "argless translate with empty with keeps JSON",
			json: `{"rawtext":[{"translate":"forms.starter.title","with":[]}]}`,
			want: `{"rawtext":[{"translate":"forms.starter.title","with":[]}]}`,
		},
		{
			name: "nested rawtext",
			json: `{"rawtext":[{"rawtext":[{"text":"inner"}]}]}`,
			want: "inner",
		},
	} {
		t.Run(test.name, func(t *testing.T) {
			var got Text
			if err := json.Unmarshal([]byte(test.json), &got); err != nil {
				t.Fatalf("unmarshal %s: %v", test.json, err)
			}
			if got.String() != test.want {
				t.Fatalf("got %q, want %q", got, test.want)
			}
		})
	}
}

// TestTextNeverFailsToUnmarshal guards the property that matters most: this
// decodes inside a packet handler, and an error there disconnects the bot and
// loses the whole run. An unrecognised shape must degrade, not fail.
func TestTextNeverFailsToUnmarshal(t *testing.T) {
	for _, shape := range []string{
		`12345`,
		`true`,
		`null`,
		`[]`,
		`{"unexpected":"shape"}`,
		`{"rawtext":[]}`,
	} {
		var got Text
		if err := json.Unmarshal([]byte(shape), &got); err != nil {
			t.Fatalf("unmarshal %s returned %v; must never error", shape, err)
		}
	}
}

// TestFormTitleFromRawtext exercises the path that actually broke: a menu form
// whose title and buttons are localised.
func TestFormTitleFromRawtext(t *testing.T) {
	payload := `{
		"type": "form",
		"title": {"rawtext":[{"translate":"pc.title"}]},
		"content": "",
		"buttons": [
			{"text": {"rawtext":[{"translate":"pc.button.deposit"}]}},
			{"text": "Withdraw"}
		]
	}`

	form, err := NewForm([]byte(payload), 1, nil)
	if err != nil {
		t.Fatalf("NewForm: %v", err)
	}
	if want := `{"rawtext":[{"translate":"pc.title"}]}`; form.Title() != want {
		t.Fatalf("title = %q, want %q", form.Title(), want)
	}

	buttons, ok := form.MenuFormButtons()
	if !ok {
		t.Fatal("expected a menu form")
	}
	if len(buttons) != 2 {
		t.Fatalf("got %d buttons, want 2", len(buttons))
	}
	if want := `{"rawtext":[{"translate":"pc.button.deposit"}]}`; buttons[0].Text() != want {
		t.Fatalf("button 0 = %q", buttons[0].Text())
	}
	if buttons[1].Text() != "Withdraw" {
		t.Fatalf("button 1 = %q", buttons[1].Text())
	}
}
