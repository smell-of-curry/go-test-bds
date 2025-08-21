package instruction

import (
	"context"

	"github.com/df-mc/dragonfly/server/block/cube"
	"github.com/go-gl/mathgl/mgl64"
	"github.com/smell-of-curry/go-test-bds/gotestbds/actor"
	"github.com/smell-of-curry/go-test-bds/gotestbds/bot"
)

// InteractWithBlock ...
type InteractWithBlock struct {
	Pos      Pos        `json:"pos"`
	Face     cube.Face  `json:"face"`
	ClickPos mgl64.Vec3 `json:"clickPos"`
}

// Name ...
func (*InteractWithBlock) Name() string {
	return "interactWithBlock"
}

// Run ...
func (i *InteractWithBlock) Run(ctx context.Context, b *bot.Bot) error {
	return execute(b, func(a *actor.Actor) error {
		a.UseItemOnBlock(cube.Pos(i.Pos), i.Face, i.ClickPos)
		return nil
	})
}
