package instruction

import (
	"context"
	"fmt"
	"time"

	"github.com/df-mc/dragonfly/server/block/cube"
	"github.com/smell-of-curry/go-test-bds/gotestbds/actor"
	"github.com/smell-of-curry/go-test-bds/gotestbds/bot"
)

// navDetailWait bounds how long we wait for the tick loop to hand back
// NavFailureDetail after a failed navigate. An unbounded Execute await hung
// showcase legs when the tick loop was saturated (viewer + dense world).
const navDetailWait = 5 * time.Second

// NavigateToBlock navigates the Actor to a target block position.
type NavigateToBlock struct {
	Callbacker Callbacker `json:"_"`
	Pos        Pos        `json:"pos"`
}

// Name is the name of the instruction.
func (*NavigateToBlock) Name() string {
	return "navigateToBlock"
}

// Run is the function that runs the instruction.
func (n *NavigateToBlock) Run(ctx context.Context, b *bot.Bot) error {
	// Buffered + non-blocking send: the callback fires on the bot's tick loop,
	// possibly AFTER Run returned (ctx timeout queues StopNavigating, which
	// fires the one-shot callback with no reader left). An unbuffered send
	// there deadlocked the entire tick loop — run 32 froze mid-showcase.
	navigateCh := make(chan bool, 1)
	_ = execute(b, func(a *actor.Actor) error {
		n.Callbacker.SetNavigationCallback(navigationCallback(navigateCh))
		a.Navigate(cube.Pos(n.Pos))
		return nil
	})

	select {
	case <-ctx.Done():
		done := b.Execute(func(a *actor.Actor) {
			a.StopNavigating()
		})
		select {
		case <-done:
		case <-time.After(navDetailWait):
		}
		return ctx.Err()
	case ok := <-navigateCh:
		if !ok {
			// Must await Execute: fire-and-forget raced the tick loop and
			// always read detail="" → bare "unable to reach destination"
			// with no diagnostic (live a5ab5fa showcase). Bound the wait so a
			// saturated tick loop cannot hang the suite for minutes.
			var detail string
			done := b.Execute(func(a *actor.Actor) {
				detail = a.NavFailureDetail()
				a.StopNavigating()
			})
			select {
			case <-done:
			case <-time.After(navDetailWait):
			case <-ctx.Done():
				return ctx.Err()
			}
			if detail != "" && detail != "stopped" {
				return fmt.Errorf("unable to reach destination (%s)", detail)
			}
			return fmt.Errorf("unable to reach destination")
		}
	}

	return nil
}

// navigationCallback wraps the result channel in a send that can never block
// the caller: the callback runs on the bot's tick loop, and when it fires
// after Run has already returned (ctx timeout → queued StopNavigating → the
// one-shot callback) a bare send would freeze the tick loop for good.
//
// @param ch The result channel, buffered with capacity >= 1.
// @returns a callback safe to fire with or without a reader.
func navigationCallback(ch chan bool) func(bool) {
	return func(ok bool) {
		select {
		case ch <- ok:
		default:
		}
	}
}
