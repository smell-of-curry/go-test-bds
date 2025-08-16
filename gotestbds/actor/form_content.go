package actor

import (
	"encoding/json"
	"fmt"
)

// Content ...
type Content struct {
	content []FormElement
	f       *Form
}

// Elements ...
func (c *Content) Elements() []FormElement {
	return c.content
}

// MarshalJSON ...
func (c *Content) MarshalJSON() ([]byte, error) {
	var response []any
	for _, element := range c.content {
		response = append(response, element.ResponseValue())
	}
	return json.Marshal(response)
}

// UnmarshalJSON ...
func (c *Content) UnmarshalJSON(data []byte) error {
	var elems []json.RawMessage
	err := json.Unmarshal(data, &elems)
	if err != nil {
		return err
	}

	for _, elem := range elems {
		var element = struct {
			Type string `json:"type"`
		}{}
		err = json.Unmarshal(elem, &element)
		if err != nil {
			return err
		}
		var formElement FormElement
		switch element.Type {
		case "label":
			formElement = &FormLabel{}
		case "input":
			formElement = &FormInput{}
		case "toggle":
			formElement = &FormToggle{}
		case "slider":
			formElement = &FormSlider{}
		case "dropdown":
			formElement = &FormDropDown{}
		case "step_slider":
			formElement = &FormStepSlider{}
		default:
			return fmt.Errorf("unknown element %s", elem)
		}
		err = json.Unmarshal(elem, formElement)
		if err != nil {
			return err
		}
		c.content = append(c.content, formElement)
	}
	return nil
}

// Submit ...
func (c *Content) Submit() error {
	return c.f.submit(c)
}
