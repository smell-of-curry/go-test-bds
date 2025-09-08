package instruction

import (
	"context"
	"fmt"

	"github.com/smell-of-curry/go-test-bds/gotestbds/actor"
	"github.com/smell-of-curry/go-test-bds/gotestbds/bot"
)

// ModalFormRespond responds to a modal form with yes/no, or ignores it.
type ModalFormRespond struct {
	Response bool `json:"response"`
	Ignore   bool `json:"ignore"`
}

// Name is the name of the instruction.
func (*ModalFormRespond) Name() string {
	return "modalFormRespond"
}

// Run is the function that runs the instruction.
func (m *ModalFormRespond) Run(ctx context.Context, b *bot.Bot) error {
	return execute(b, func(a *actor.Actor) error {
		f, ok := a.LastForm()
		if !ok {
			return fmt.Errorf("no new forms were received")
		}
		yes, no, ok := f.ModalFormButtons()
		if !ok {
			return fmt.Errorf("form is of type %s, not %s", f.Type(), actor.FormTypeModal)
		}

		if m.Ignore {
			return f.Ignore()
		}

		var err error
		if m.Response {
			err = yes.Press()
		} else {
			err = no.Press()
		}
		return err
	})
}
