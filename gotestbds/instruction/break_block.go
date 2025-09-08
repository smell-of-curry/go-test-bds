package instruction

import (
	"context"
	"fmt"

	"github.com/df-mc/dragonfly/server/block/cube"
	"github.com/smell-of-curry/go-test-bds/gotestbds/actor"
	"github.com/smell-of-curry/go-test-bds/gotestbds/bot"
)

// BreakBlock is an instruction to break a block at a given position.
type BreakBlock struct {
	Callbacker Callbacker `json:"_"`
	Pos        Pos        `json:"pos"`
}

// Name is the name of the instruction.
func (*BreakBlock) Name() string {
	return "breakBlock"
}

// Run is the function that runs the instruction.
func (action *BreakBlock) Run(ctx context.Context, b *bot.Bot) error {
	breakCh := make(chan bool)
	err := execute(b, func(a *actor.Actor) error {
		action.Callbacker.SetBreakingCallback(func(b bool) { breakCh <- b })
		_, err := a.StartBreakingBlock(cube.Pos(action.Pos))
		if err != nil {
			return fmt.Errorf("unable to start breaking block err: %w", err)
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
