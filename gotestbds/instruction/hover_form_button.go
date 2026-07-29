package instruction

import (
	"context"
	"fmt"
	"time"

	"github.com/smell-of-curry/go-test-bds/gotestbds/actor"
	"github.com/smell-of-curry/go-test-bds/gotestbds/bot"
	"github.com/smell-of-curry/go-test-bds/gotestbds/viewer"
)

// HoverFormButton visually hovers one open-form button in the attached viewer,
// then waits Ms milliseconds so a recording shows the choice settling before
// it is clicked. Hovering is presentation only: with no viewer attached the
// instruction validates the form and returns immediately (no wait, no error),
// so suites that run headless pay nothing for it.
type HoverFormButton struct {
	Index int `json:"index"`
	Ms    int `json:"ms"`
	hub   *viewer.Hub
}

// Name returns the instruction name.
func (*HoverFormButton) Name() string {
	return "hoverFormButton"
}

// Run emits the formHover stream event for the bot's open form, then waits.
func (h *HoverFormButton) Run(ctx context.Context, b *bot.Bot) error {
	var botName string
	if err := execute(b, func(a *actor.Actor) error {
		f, ok := a.LastForm()
		if !ok {
			return fmt.Errorf("no open form")
		}
		n := 0
		switch f.Type() {
		case actor.FormTypeMenu:
			buttons, _ := f.MenuFormButtons()
			n = len(buttons)
		case actor.FormTypeModal:
			n = 2
		default:
			return fmt.Errorf("hoverFormButton supports menu/modal forms, got %s", f.Type())
		}
		if h.Index < 0 || h.Index >= n {
			return fmt.Errorf("invalid button index %d: valid range is 0..%d", h.Index, n-1)
		}
		botName = a.Name()
		return nil
	}); err != nil {
		return err
	}

	// Silent no-op without a viewer: nothing would render the hover, so the
	// wait would only slow the suite down.
	if h.hub == nil || h.hub.Attached(botName) == 0 {
		return nil
	}
	h.hub.FormHover(botName, h.Index)
	if h.Ms <= 0 {
		return nil
	}
	select {
	case <-ctx.Done():
		return ctx.Err()
	case <-time.After(time.Duration(h.Ms) * time.Millisecond):
		return nil
	}
}
