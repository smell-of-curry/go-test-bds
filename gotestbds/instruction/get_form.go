package instruction

import (
	"context"

	"github.com/smell-of-curry/go-test-bds/gotestbds/actor"
	"github.com/smell-of-curry/go-test-bds/gotestbds/bot"
)

// GetForm returns the currently open form without consuming it.
type GetForm struct {
	result any
}

// Name returns the instruction name.
func (*GetForm) Name() string {
	return "getForm"
}

// Run observes the currently open form, or null when none is open.
func (g *GetForm) Run(ctx context.Context, b *bot.Bot) error {
	return execute(b, func(a *actor.Actor) error {
		if data, ok := observeForm(a); ok {
			g.result = data
			return nil
		}
		// typed nil so status JSON encodes "data": null
		var none *formDataJSON
		g.result = none
		return nil
	})
}

// Data returns the form payload (or null) from the last successful Run.
func (g *GetForm) Data() any {
	return g.result
}
