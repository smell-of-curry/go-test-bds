package instruction

import "github.com/smell-of-curry/go-test-bds/gotestbds/bot"

// Instruction ...
type Instruction interface {
	// Name returns name of the instruction to identify instruction in the pull.
	Name() string
	// Run runs instruction on the Bot.
	Run(b *bot.Bot) bool
}
