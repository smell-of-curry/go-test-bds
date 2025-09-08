package instruction

import (
	"context"
	"github.com/smell-of-curry/go-test-bds/gotestbds/bot"
)

// Disconnect closes the Bot connection.
type Disconnect struct{}

// Name is the name of the instruction.
func (*Disconnect) Name() string {
	return "disconnect"
}

// Run is the function that runs the instruction.
func (*Disconnect) Run(ctx context.Context, b *bot.Bot) error {
	return b.Close()
}
