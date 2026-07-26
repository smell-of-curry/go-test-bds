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
			name: "translation key",
			json: `{"rawtext":[{"translate":"forms.starter.title"}]}`,
			want: "forms.starter.title",
		},
		{
			name: "concatenated parts",
			json: `{"rawtext":[{"text":"§l"},{"translate":"forms.starter.title"},{"text":" (1/3)"}]}`,
			want: "§l" + "forms.starter.title" + " (1/3)",
		},
		{
			name: "bare translate object",
			json: `{"translate":"forms.starter.title","with":["Bulbasaur"]}`,
			want: "forms.starter.title",
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
	if form.Title() != "pc.title" {
		t.Fatalf("title = %q, want %q", form.Title(), "pc.title")
	}

	buttons, ok := form.MenuFormButtons()
	if !ok {
		t.Fatal("expected a menu form")
	}
	if len(buttons) != 2 {
		t.Fatalf("got %d buttons, want 2", len(buttons))
	}
	if buttons[0].Text() != "pc.button.deposit" {
		t.Fatalf("button 0 = %q", buttons[0].Text())
	}
	if buttons[1].Text() != "Withdraw" {
		t.Fatalf("button 1 = %q", buttons[1].Text())
	}
}
