package instruction

import (
	"context"
	"github.com/smell-of-curry/go-test-bds/gotestbds/actor"
	"github.com/smell-of-curry/go-test-bds/gotestbds/bot"
)

// Chat ...
type Chat struct {
	Message string `json:"message"`
}

// Name ...
func (*Chat) Name() string {
	return "chat"
}

// Run ...
func (i *Chat) Run(ctx context.Context, b *bot.Bot) error {
	return execute(b, func(a *actor.Actor) error {
		a.Chat(i.Message)
		return nil
	})
}
