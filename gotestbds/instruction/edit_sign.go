package instruction

import (
	"context"
	"fmt"

	"github.com/smell-of-curry/go-test-bds/gotestbds/actor"
	"github.com/smell-of-curry/go-test-bds/gotestbds/bot"
)

// EditSign edits the last Sign sent to the Actor.
type EditSign struct {
	Text string `json:"text"`
}

// Name is the name of the instruction.
func (*EditSign) Name() string {
	return "editSign"
}

// Run is the function that runs the instruction.
func (e *EditSign) Run(ctx context.Context, b *bot.Bot) error {
	return execute(b, func(a *actor.Actor) error {
		sign, ok := a.LastSign()
		if !ok {
			return fmt.Errorf("no new signs were received")
		}
		return sign.Edit(e.Text)
	})
}
