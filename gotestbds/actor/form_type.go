package actor

import "encoding/json"

// FormType ...
type FormType string

const (
	FormTypeCustom FormType = "custom_form"
	FormTypeModal  FormType = "modal"
	FormTypeMenu   FormType = "form"
)

// modalForm ...
type modalForm struct {
	Button1 FormButton `json:"button1"`
	Button2 FormButton `json:"button2"`
}

// UnmarshalJSON decodes a modal form from either payload layout.
//
// @param data The raw form JSON.
// @returns an error only when neither layout decodes.
func (m *modalForm) UnmarshalJSON(data []byte) error {
	shape := struct {
		Button1 *FormButton `json:"button1"`
		Button2 *FormButton `json:"button2"`
	}{}
	if err := json.Unmarshal(data, &shape); err != nil {
		return err
	}
	if shape.Button1 != nil && shape.Button2 != nil {
		m.Button1, m.Button2 = *shape.Button1, *shape.Button2
		return nil
	}

	buttons, err := buttonElements(data)
	if err != nil {
		return err
	}
	if len(buttons) > 0 {
		m.Button1 = buttons[0]
	}
	if len(buttons) > 1 {
		m.Button2 = buttons[1]
	}
	return nil
}

// menuForm ...
type menuForm struct {
	Buttons []FormButton `json:"buttons"`
}

// UnmarshalJSON decodes a menu form from either payload layout.
//
// Current Bedrock builds send menu buttons as typed entries in an `elements`
// array; older ones sent a flat `buttons` array. A bot that only reads
// `buttons` decodes such a form as having none, which surfaces as an
// unclickable form rather than as a parse failure.
//
// @param data The raw form JSON.
// @returns an error only when neither layout decodes.
func (m *menuForm) UnmarshalJSON(data []byte) error {
	shape := struct {
		Buttons []FormButton `json:"buttons"`
	}{}
	if err := json.Unmarshal(data, &shape); err != nil {
		return err
	}
	if len(shape.Buttons) > 0 {
		m.Buttons = shape.Buttons
		return nil
	}

	buttons, err := buttonElements(data)
	if err != nil {
		return err
	}
	m.Buttons = buttons
	return nil
}

// customForm ...
type customForm struct {
	Content Content `json:"content"`
}

// UnmarshalJSON decodes a custom form from either payload layout.
//
// @param data The raw form JSON.
// @returns an error only when neither layout decodes.
func (c *customForm) UnmarshalJSON(data []byte) error {
	shape := struct {
		Content *Content `json:"content"`
	}{}
	if err := json.Unmarshal(data, &shape); err == nil && shape.Content != nil {
		c.Content = *shape.Content
		return nil
	}

	elements, err := formElements(data)
	if err != nil {
		return err
	}
	// Buttons are not custom-form elements; Content rejects them outright.
	kept := make([]json.RawMessage, 0, len(elements))
	for _, el := range elements {
		if elementType(el) == "button" {
			continue
		}
		kept = append(kept, el)
	}
	rest, err := json.Marshal(kept)
	if err != nil {
		return err
	}
	return c.Content.UnmarshalJSON(rest)
}

// formElements returns the raw entries of a form's `elements` array.
//
// @param data The raw form JSON.
// @returns the entries, empty when the form carries no such array.
// @throws if `elements` is present but not an array of objects.
func formElements(data []byte) ([]json.RawMessage, error) {
	shape := struct {
		Elements []json.RawMessage `json:"elements"`
	}{}
	if err := json.Unmarshal(data, &shape); err != nil {
		return nil, err
	}
	return shape.Elements, nil
}

// buttonElements returns the buttons of a form's `elements` array, in order.
//
// @param data The raw form JSON.
// @returns the buttons, empty when the form carries none.
// @throws if a button entry cannot be decoded.
func buttonElements(data []byte) ([]FormButton, error) {
	elements, err := formElements(data)
	if err != nil {
		return nil, err
	}

	var buttons []FormButton
	for _, el := range elements {
		if elementType(el) != "button" {
			continue
		}
		var button FormButton
		if err := json.Unmarshal(el, &button); err != nil {
			return nil, err
		}
		buttons = append(buttons, button)
	}
	return buttons, nil
}

// elementType reads the `type` discriminator of a form element.
//
// @param element The raw element JSON.
// @returns the type, empty when the element has none.
func elementType(element json.RawMessage) string {
	head := struct {
		Type string `json:"type"`
	}{}
	if json.Unmarshal(element, &head) != nil {
		return ""
	}
	return head.Type
}
