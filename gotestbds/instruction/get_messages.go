package instruction

import (
	"context"

	"github.com/smell-of-curry/go-test-bds/gotestbds/actor"
	"github.com/smell-of-curry/go-test-bds/gotestbds/bot"
)

// GetMessages returns recent received chat/system messages.
type GetMessages struct {
	Limit  int `json:"limit"`
	result any
}

// Name returns the instruction name.
func (*GetMessages) Name() string {
	return "getMessages"
}

// Run returns up to Limit recent messages (default 50), newest last.
func (g *GetMessages) Run(ctx context.Context, b *bot.Bot) error {
	return execute(b, func(a *actor.Actor) error {
		limit := g.Limit
		if limit <= 0 {
			limit = 50
		}
		msgs := a.RecentMessages(limit)
		if msgs == nil {
			msgs = []actor.ReceivedMessage{}
		}
		g.result = map[string]any{"messages": msgs}
		return nil
	})
}

// Data returns the messages payload from the last successful Run.
func (g *GetMessages) Data() any {
	return g.result
}
