package instruction

import (
	"context"

	"github.com/smell-of-curry/go-test-bds/gotestbds/actor"
	"github.com/smell-of-curry/go-test-bds/gotestbds/bot"
	"github.com/smell-of-curry/go-test-bds/gotestbds/mcmath/physics/movement"
)

// HoldInput holds stick and buttons for Ticks actor ticks (20 Hz).
// While riding, the ticks steer the vehicle instead of walking the player.
type HoldInput struct {
	Forward bool `json:"forward"`
	Back    bool `json:"back"`
	Left    bool `json:"left"`
	Right   bool `json:"right"`
	Jump    bool `json:"jump"`
	Sneak   bool `json:"sneak"`
	Ticks   int  `json:"ticks"`
}

// Name is the name of the instruction.
func (*HoldInput) Name() string {
	return "holdInput"
}

// Run is the function that runs the instruction.
func (h *HoldInput) Run(ctx context.Context, b *bot.Bot) error {
	var done <-chan struct{}
	err := execute(b, func(a *actor.Actor) error {
		ch, startErr := a.StartHold(movement.Input{
			Forward: h.Forward,
			Back:    h.Back,
			Left:    h.Left,
			Right:   h.Right,
			Jump:    h.Jump,
			Sneak:   h.Sneak,
		}, h.Ticks)
		done = ch
		return startErr
	})
	if err != nil {
		return err
	}

	select {
	case <-ctx.Done():
		stop := b.Execute(func(a *actor.Actor) {
			a.StopHold()
		})
		select {
		case <-stop:
		case <-ctx.Done():
		}
		return ctx.Err()
	case <-done:
		return nil
	}
}
