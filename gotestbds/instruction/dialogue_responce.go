package instruction

import (
	"context"
	"fmt"

	"github.com/smell-of-curry/go-test-bds/gotestbds/actor"
	"github.com/smell-of-curry/go-test-bds/gotestbds/bot"
)

// DialogueResponse responds to dialogue.
type DialogueResponse struct {
	ButtonIndex int  `json:"buttonIndex"`
	Ignore      bool `json:"ignore"`
}

// Name ...
func (d *DialogueResponse) Name() string {
	return "dialogueResponse"
}

// Run ...
func (d *DialogueResponse) Run(ctx context.Context, b *bot.Bot) error {
	return execute(b, func(a *actor.Actor) error {
		dialogue, ok := a.LastDialogue()
		if !ok {
			return fmt.Errorf("no new dialogues were received")
		}
		buttons := dialogue.Buttons()
		if d.ButtonIndex >= len(buttons) {
			return fmt.Errorf("invalid button index")
		}
		return buttons[d.ButtonIndex].Press()
	})
}
