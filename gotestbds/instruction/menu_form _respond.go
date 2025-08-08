package instruction

import (
	"context"
	"fmt"

	"github.com/smell-of-curry/go-test-bds/gotestbds/actor"
	"github.com/smell-of-curry/go-test-bds/gotestbds/bot"
)

// MenuFormRespond ...
type MenuFormRespond struct {
	Response int  `json:"response"`
	Ignore   bool `json:"ignore"`
}

// Name ...
func (*MenuFormRespond) Name() string {
	return "menuFormRespond"
}

// Run ...
func (m *MenuFormRespond) Run(ctx context.Context, b *bot.Bot) error {
	return execute(b, func(a *actor.Actor) error {
		f, ok := a.LastForm()
		if !ok {
			return fmt.Errorf("no new forms were received")
		}
		buttons, ok := f.MenuFormButtons()
		if !ok {
			return fmt.Errorf("form is of type %s, not %s", f.Type(), actor.FormTypeMenu)
		}

		if m.Ignore {
			return f.Ignore()
		}

		if m.Response > len(buttons)+1 || m.Response < 1 {
			return fmt.Errorf("invalid button")
		}

		return buttons[m.Response-1].Press()
	})
}
