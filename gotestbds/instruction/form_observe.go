package instruction

import (
	"fmt"

	"github.com/smell-of-curry/go-test-bds/gotestbds/actor"
)

// formButtonJSON is a menu-form button in observation payloads.
type formButtonJSON struct {
	Text  string         `json:"text"`
	Image *formImageJSON `json:"image,omitempty"`
}

// formImageJSON is an optional button image.
type formImageJSON struct {
	Type string `json:"type"`
	Data string `json:"data"`
}

// formContentJSON is one custom-form element in observation payloads.
type formContentJSON struct {
	Type         string   `json:"type"`
	Text         string   `json:"text,omitempty"`
	Default      any      `json:"default,omitempty"`
	Placeholder  string   `json:"placeholder,omitempty"`
	Min          *float64 `json:"min,omitempty"`
	Max          *float64 `json:"max,omitempty"`
	Step         *float64 `json:"step,omitempty"`
	Options      []string `json:"options,omitempty"`
	DefaultIndex *int     `json:"defaultIndex,omitempty"`
}

// formDataJSON is the observation shape for an open form.
type formDataJSON struct {
	Type    string            `json:"type"`
	Title   string            `json:"title"`
	Buttons []formButtonJSON  `json:"buttons,omitempty"`
	Button1 string            `json:"button1,omitempty"`
	Button2 string            `json:"button2,omitempty"`
	Content []formContentJSON `json:"content,omitempty"`
}

// observeForm returns the current open form data, or (nil, false) when none is open.
// It does not consume or submit the form.
func observeForm(a *actor.Actor) (*formDataJSON, bool) {
	f, ok := a.LastForm()
	if !ok {
		return nil, false
	}
	return formToData(f), true
}

// formToData serializes an open form without consuming it.
func formToData(f *actor.Form) *formDataJSON {
	out := &formDataJSON{
		Type:  wireFormType(f.Type()),
		Title: f.Title(),
	}
	switch f.Type() {
	case actor.FormTypeMenu:
		buttons, _ := f.MenuFormButtons()
		for _, b := range buttons {
			out.Buttons = append(out.Buttons, buttonToJSON(b))
		}
	case actor.FormTypeModal:
		b1, b2, _ := f.ModalFormButtons()
		out.Button1 = b1.Text()
		out.Button2 = b2.Text()
	case actor.FormTypeCustom:
		content, _ := f.CustomFormContent()
		for _, el := range content.Elements() {
			out.Content = append(out.Content, elementToJSON(el))
		}
	}
	return out
}

// wireFormType maps actor form types to SDK wire names.
func wireFormType(t actor.FormType) string {
	switch t {
	case actor.FormTypeMenu:
		return "menu"
	case actor.FormTypeModal:
		return "modal"
	case actor.FormTypeCustom:
		return "custom"
	default:
		return string(t)
	}
}

func buttonToJSON(b actor.FormButton) formButtonJSON {
	out := formButtonJSON{Text: b.Text()}
	img := b.Image()
	if img.Type != "" || img.Data != "" {
		out.Image = &formImageJSON{Type: img.Type, Data: img.Data}
	}
	return out
}

func elementToJSON(el actor.FormElement) formContentJSON {
	switch e := el.(type) {
	case *actor.FormLabel:
		return formContentJSON{Type: "label", Text: e.Text()}
	case *actor.FormInput:
		return formContentJSON{
			Type:        "input",
			Text:        e.Text(),
			Default:     e.Default(),
			Placeholder: e.Placeholder(),
		}
	case *actor.FormToggle:
		return formContentJSON{Type: "toggle", Text: e.Text(), Default: e.Default()}
	case *actor.FormSlider:
		min, max, step := e.Min(), e.Max(), e.StepSize()
		return formContentJSON{
			Type:    "slider",
			Text:    e.Text(),
			Default: e.Default(),
			Min:     &min,
			Max:     &max,
			Step:    &step,
		}
	case *actor.FormDropDown:
		idx := e.Default()
		return formContentJSON{
			Type:         "dropdown",
			Text:         e.Text(),
			Options:      e.Options(),
			DefaultIndex: &idx,
		}
	case *actor.FormStepSlider:
		idx := e.Default()
		return formContentJSON{
			Type:         "step_slider",
			Text:         e.Text(),
			Options:      e.Options(),
			DefaultIndex: &idx,
		}
	default:
		return formContentJSON{Type: fmt.Sprintf("%T", el), Text: el.Text()}
	}
}
