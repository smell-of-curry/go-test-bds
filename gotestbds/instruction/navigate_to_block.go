package instruction

import (
	"context"
	"fmt"

	"github.com/df-mc/dragonfly/server/block/cube"
	"github.com/smell-of-curry/go-test-bds/gotestbds/actor"
	"github.com/smell-of-curry/go-test-bds/gotestbds/bot"
)

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
	navigateCh := make(chan bool)
	_ = execute(b, func(a *actor.Actor) error {
		n.Callbacker.SetNavigationCallback(func(b bool) { navigateCh <- b })
		a.Navigate(cube.Pos(n.Pos))
		return nil
	})

	select {
	case <-ctx.Done():
		b.Execute(func(a *actor.Actor) {
			a.StopNavigating()
		})
		return ctx.Err()
	case ok := <-navigateCh:
		if !ok {
			b.Execute(func(a *actor.Actor) { a.StopNavigating() })
			return fmt.Errorf("unable to reach destination")
		}
	}

	return nil
}
