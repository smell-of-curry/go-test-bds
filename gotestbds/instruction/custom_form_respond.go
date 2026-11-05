package instruction

import (
	"context"
	"fmt"
	"math"

	"github.com/smell-of-curry/go-test-bds/gotestbds/actor"
	"github.com/smell-of-curry/go-test-bds/gotestbds/bot"
)

// CustomFormRespond is an instruction to respond to a custom form.
type CustomFormRespond struct {
	Options []Option `json:"options"`
	Ignore  bool     `json:"ignore"`
}

// Name is the name of the instruction.
func (*CustomFormRespond) Name() string {
	return "customFormRespond"
}

// Run is the function that runs the instruction.
func (c *CustomFormRespond) Run(ctx context.Context, b *bot.Bot) error {
	return execute(b, func(a *actor.Actor) error {
		f, ok := a.LastForm()
		if !ok {
			return fmt.Errorf("no new forms were received")
		}
		content, ok := f.CustomFormContent()
		if !ok {
			return fmt.Errorf("form is of type %s, not %s", f.Type(), actor.FormTypeCustom)
		}

		if c.Ignore {
			return f.Ignore()
		}

		if err := setCustomFormOptions(content.Elements(), c.Options); err != nil {
			return err
		}
		return content.Submit()
	})
}

// Option stores index to custom form element & its value.
type Option struct {
	Index int `json:"index"`
	Value any `json:"value"`
}

// setCustomFormOptions applies the same decoded options used by the control API.
func setCustomFormOptions(elements []actor.FormElement, options []Option) error {
	for _, o := range options {
		if o.Index < 0 || o.Index >= len(elements) {
			return fmt.Errorf("incorrect option index %v: valid range is 0..%d (%d elements)", o.Index, len(elements)-1, len(elements))
		}
		switch el := elements[o.Index].(type) {
		case *actor.FormInput:
			val, ok := o.Value.(string)
			if !ok {
				return fmt.Errorf("unable to cast %T into %T", o.Value, string(""))
			}
			el.SetValue(val)
		case *actor.FormToggle:
			val, ok := o.Value.(bool)
			if !ok {
				return fmt.Errorf("unable to cast %T into %T", o.Value, bool(true))
			}
			el.SetValue(val)
		case *actor.FormSlider:
			val, ok := o.Value.(float64)
			if !ok {
				return fmt.Errorf("unable to cast %T into %T", o.Value, float64(0))
			}
			el.SetValue(val)
		case *actor.FormDropDown:
			val, err := formChoiceIndex(o.Value, len(el.Options()))
			if err != nil {
				return fmt.Errorf("option %d: %w", o.Index, err)
			}
			el.SetValue(val)
		case *actor.FormStepSlider:
			val, err := formChoiceIndex(o.Value, len(el.Options()))
			if err != nil {
				return fmt.Errorf("option %d: %w", o.Index, err)
			}
			el.SetValue(val)
		default:
			return fmt.Errorf("un abble to set the value for the %T", el)
		}
	}
	return nil
}

// formChoiceIndex accepts JSON numbers without truncating fractional indices.
func formChoiceIndex(value any, count int) (int, error) {
	var index float64
	switch v := value.(type) {
	case int:
		if v < 0 || v >= count {
			return 0, fmt.Errorf("choice index %d outside 0..%d", v, count-1)
		}
		return v, nil
	case float64:
		index = v
	default:
		return 0, fmt.Errorf("choice index must be an integer, got %T", value)
	}
	if math.IsNaN(index) || math.IsInf(index, 0) || math.Trunc(index) != index || index < 0 || index >= float64(count) {
		return 0, fmt.Errorf("choice index %v outside integer range 0..%d", index, count-1)
	}
	return int(index), nil
}
