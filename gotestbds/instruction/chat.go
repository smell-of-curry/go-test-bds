package instruction

import (
	"context"
	"github.com/smell-of-curry/go-test-bds/gotestbds/actor"
	"github.com/smell-of-curry/go-test-bds/gotestbds/bot"
)

// Chat is an instruction to send a chat message.
type Chat struct {
	Message string `json:"message"`
}

// Name is the name of the instruction.
func (*Chat) Name() string {
	return "chat"
}

// Run is the function that runs the instruction.
func (i *Chat) Run(ctx context.Context, b *bot.Bot) error {
	return execute(b, func(a *actor.Actor) error {
		a.Chat(i.Message)
		return nil
	})
}
