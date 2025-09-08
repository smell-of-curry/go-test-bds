package instruction

import (
	"context"
	"fmt"

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

		elements := content.Elements()

		for _, o := range c.Options {
			if len(elements) < o.Index || o.Index < 0 {
				return fmt.Errorf("incorrect option index %v", o.Index)
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
				val, ok := o.Value.(int)
				if !ok {
					return fmt.Errorf("unable to cast %T into %T", o.Value, int(0))
				}
				el.SetValue(val)
			case *actor.FormStepSlider:
				val, ok := o.Value.(int)
				if !ok {
					return fmt.Errorf("unable to cast %T into %T", o.Value, int(0))
				}
				el.SetValue(val)
			default:
				return fmt.Errorf("un abble to set the value for the %T", el)
			}
		}
		return content.Submit()
	})
}

// Option stores index to custom form element & its value.
type Option struct {
	Index int `json:"index"`
	Value any `json:"value"`
}
