package instruction

import (
	"context"

	"github.com/smell-of-curry/go-test-bds/gotestbds/actor"
	"github.com/smell-of-curry/go-test-bds/gotestbds/bot"
)

// SetSneaking starts or stops sneaking. The next PlayerAuthInput carries the flag.
type SetSneaking struct {
	Sneaking bool `json:"sneaking"`
}

// Name is the name of the instruction.
func (*SetSneaking) Name() string {
	return "setSneaking"
}

// Run is the function that runs the instruction.
func (s *SetSneaking) Run(_ context.Context, b *bot.Bot) error {
	return execute(b, func(a *actor.Actor) error {
		if s.Sneaking {
			a.StartSneaking()
		} else {
			a.StopSneaking()
		}
		return nil
	})
}
