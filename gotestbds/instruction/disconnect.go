package instruction

import (
	"context"
	"github.com/smell-of-curry/go-test-bds/gotestbds/bot"
)

// Disconnect ...
type Disconnect struct{}

// Name ...
func (*Disconnect) Name() string {
	return "disconnect"
}

// Run ...
func (*Disconnect) Run(ctx context.Context, b *bot.Bot) error {
	return b.Close()
}
