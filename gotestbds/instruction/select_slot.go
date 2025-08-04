package instruction

import (
	"github.com/smell-of-curry/go-test-bds/gotestbds/actor"
	"github.com/smell-of-curry/go-test-bds/gotestbds/bot"
)

// SelectSlot ...
type SelectSlot struct {
	Slot int `json:"slot"`
}

// Name ...
func (s *SelectSlot) Name() string {
	return "Slot"
}

// Run ...
func (s *SelectSlot) Run(b *bot.Bot) (succeed bool) {
	ch := make(chan struct{})
	b.Execute(func(actor *actor.Actor) {
		succeed = actor.SetHeldSlot(s.Slot) == nil
		close(ch)
	})
	<-ch
	return
}
