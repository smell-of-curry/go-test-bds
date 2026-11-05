package instruction

import (
	"encoding/json"
	"math"
	"testing"

	"github.com/smell-of-curry/go-test-bds/gotestbds/actor"
)

func TestCustomFormRespondJSONChoices(t *testing.T) {
	form, err := actor.NewForm([]byte(`{"type":"custom_form","title":"Battle setup","content":[{"type":"dropdown","text":"Format","options":["Singles","Doubles"],"default":1},{"type":"step_slider","text":"Rules","steps":["Casual","Competitive","Custom"],"default":1}]}`), 1, nil)
	if err != nil {
		t.Fatal(err)
	}
	content, ok := form.CustomFormContent()
	if !ok {
		t.Fatal("expected custom form")
	}
	elements := content.Elements()
	if got := elements[1].ResponseValue(); got != 1 {
		t.Fatalf("step-slider default = %v, want 1", got)
	}
	var response CustomFormRespond
	if err := json.Unmarshal([]byte(`{"options":[{"index":0,"value":0},{"index":1,"value":2}]}`), &response); err != nil {
		t.Fatal(err)
	}
	if err := setCustomFormOptions(elements, response.Options); err != nil {
		t.Fatal(err)
	}
	if got := elements[0].ResponseValue(); got != 0 {
		t.Fatalf("dropdown = %v", got)
	}
	if got := elements[1].ResponseValue(); got != 2 {
		t.Fatalf("step-slider = %v", got)
	}
}

func TestCustomFormChoiceRejectsInvalidIndices(t *testing.T) {
	for _, value := range []any{-1, 3, -1.0, 3.0, 0.5, math.NaN(), math.Inf(1), 1e100, "1", true, nil} {
		if _, err := formChoiceIndex(value, 3); err == nil {
			t.Errorf("accepted invalid choice %#v", value)
		}
	}
	for _, value := range []any{0, 2, 0.0, 2.0} {
		if _, err := formChoiceIndex(value, 3); err != nil {
			t.Errorf("rejected choice %#v: %v", value, err)
		}
	}
	if _, err := formChoiceIndex(0.0, 0); err == nil {
		t.Error("accepted choice in empty dropdown")
	}
}
