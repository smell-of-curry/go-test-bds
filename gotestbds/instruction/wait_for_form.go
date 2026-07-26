package instruction

import (
	"context"
	"fmt"
	"time"

	"github.com/smell-of-curry/go-test-bds/gotestbds/actor"
	"github.com/smell-of-curry/go-test-bds/gotestbds/bot"
)

// WaitForForm blocks until a form is open, then returns the same shape as getForm.
type WaitForForm struct {
	TimeoutMs int `json:"timeoutMs"`
	result    any
}

// Name returns the instruction name.
func (*WaitForForm) Name() string {
	return "waitForForm"
}

// Run polls until a form is open or the timeout elapses.
func (w *WaitForForm) Run(ctx context.Context, b *bot.Bot) error {
	if w.TimeoutMs > 0 {
		var cancel context.CancelFunc
		ctx, cancel = context.WithTimeout(ctx, time.Duration(w.TimeoutMs)*time.Millisecond)
		defer cancel()
	}

	ticker := time.NewTicker(50 * time.Millisecond)
	defer ticker.Stop()

	for {
		var (
			data  *formDataJSON
			found bool
		)
		if err := execute(b, func(a *actor.Actor) error {
			data, found = observeForm(a)
			return nil
		}); err != nil {
			return err
		}
		if found {
			w.result = data
			return nil
		}

		select {
		case <-ctx.Done():
			return fmt.Errorf("timed out waiting for form: %w", ctx.Err())
		case <-ticker.C:
		}
	}
}

// Data returns the form payload from the last successful Run.
func (w *WaitForForm) Data() any {
	return w.result
}
