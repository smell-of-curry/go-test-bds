package instruction

import (
	"context"
	"fmt"
	"time"

	"github.com/smell-of-curry/go-test-bds/gotestbds/actor"
	"github.com/smell-of-curry/go-test-bds/gotestbds/bot"
)

// Rejoin ...
type Rejoin struct {
	// Delay is a delay in seconds before re-run.
	Delay int `json:"delay"`
}

// Name ...
func (*Rejoin) Name() string {
	return "rejoin"
}

// Run ...
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
