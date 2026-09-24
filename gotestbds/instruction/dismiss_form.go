package instruction

import (
	"context"
	"fmt"

	"github.com/smell-of-curry/go-test-bds/gotestbds/actor"
	"github.com/smell-of-curry/go-test-bds/gotestbds/bot"
)

// DismissForm closes whatever form the bot has open (menu, modal, or custom),
// as though the player dismissed it without answering.
type DismissForm struct{}

// Name is the name of the instruction.
func (*DismissForm) Name() string {
	return "dismissForm"
}

// Run is the function that runs the instruction.
func (*DismissForm) Run(ctx context.Context, b *bot.Bot) error {
	return execute(b, func(a *actor.Actor) error {
		f, ok := a.LastForm()
		if !ok {
			return fmt.Errorf("no new forms were received")
		}
		return f.Ignore()
	})
}
