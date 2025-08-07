package instruction

import (
	"context"
	"fmt"
	"github.com/df-mc/dragonfly/server/block/cube"
	"github.com/smell-of-curry/go-test-bds/gotestbds/actor"
	"github.com/smell-of-curry/go-test-bds/gotestbds/bot"
)

// BreakBlock ...
type BreakBlock struct {
	Callbacker Callbacker `json:"_"`
	Pos        cube.Pos   `json:"pos"`
}

// Name ...
func (*BreakBlock) Name() string {
	return "breakBlock"
}

// Run ...
func (action *BreakBlock) Run(ctx context.Context, b *bot.Bot) error {
	breakCh := make(chan bool)
	err := execute(b, func(a *actor.Actor) error {
		action.Callbacker.SetBreakingCallback(func(b bool) { breakCh <- b })
		_, ok := a.StartBreakingBlock(action.Pos)
		if !ok {
			return fmt.Errorf("unbreakable block")
		}
		return nil
	})
	if err != nil {
		return err
	}

	select {
	case broke := <-breakCh:
		if !broke {
			return fmt.Errorf("breaking aborted")
		}
	case <-ctx.Done():
		b.Execute(func(a *actor.Actor) { a.AbortBreaking() })
		return ctx.Err()
	}

	return nil
}
