package instruction

import (
	"fmt"
	"github.com/smell-of-curry/go-test-bds/gotestbds/actor"
	"github.com/smell-of-curry/go-test-bds/gotestbds/bot"
)

// Attack attacks entity from Actor's view direction.
type Attack struct{}

// Name ...
func (*Attack) Name() string {
	return "attack"
}

// Run ...
func (*Attack) Run(b *bot.Bot) error {
	return execute(b, func(a *actor.Actor) error {
		if !a.Attack() {
			return fmt.Errorf("entity not found")
		}
		return nil
	})
}
