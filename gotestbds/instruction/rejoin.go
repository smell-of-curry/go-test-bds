package instruction

import (
	"context"
	"fmt"
	"time"

	"github.com/smell-of-curry/go-test-bds/gotestbds/actor"
	"github.com/smell-of-curry/go-test-bds/gotestbds/bot"
)

// Rejoin triggers the handler's Rejoin() after a configurable delay.
type Rejoin struct {
	// Delay is a delay in seconds before re-run.
	Delay int `json:"delay"`
}

// Name is the name of the instruction.
func (*Rejoin) Name() string {
	return "rejoin"
}

// Run is the function that runs the instruction.
func (r *Rejoin) Run(ctx context.Context, b *bot.Bot) error {
	return execute(b, func(a *actor.Actor) error {
		handler := a.Handler()
		rejoiner, ok := handler.(interface{ Rejoin() error })
		if !ok {
			return fmt.Errorf("handler does not implement `Rejoin() error` method")
		}
		time.AfterFunc(time.Duration(r.Delay)*time.Second, func() {
			_ = rejoiner.Rejoin()
		})
		return nil
	})
}
