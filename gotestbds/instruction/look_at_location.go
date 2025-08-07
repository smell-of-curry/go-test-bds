package instruction

import (
	"context"
	"github.com/go-gl/mathgl/mgl64"
	"github.com/smell-of-curry/go-test-bds/gotestbds/actor"
	"github.com/smell-of-curry/go-test-bds/gotestbds/bot"
)

// LookAtLocation ...
type LookAtLocation struct {
	Location mgl64.Vec3 `json:"location"`
}

// Name ...
func (*LookAtLocation) Name() string {
	return "lookAtLocation"
}

// Run ...
func (l *LookAtLocation) Run(ctx context.Context, b *bot.Bot) error {
	return execute(b, func(a *actor.Actor) error {
		a.LookAt(l.Location)
		return nil
	})
}
