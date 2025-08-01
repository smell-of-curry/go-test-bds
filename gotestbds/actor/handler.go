package actor

import (
	"github.com/df-mc/dragonfly/server/block/cube"
	"github.com/df-mc/dragonfly/server/event"
	w "github.com/df-mc/dragonfly/server/world"
	"github.com/go-gl/mathgl/mgl64"
	"github.com/smell-of-curry/go-test-bds/gotestbds/world"
)

type Context = event.Context[*Actor]

type Handler interface {
	HandleMove(ctx *Context, rot *cube.Rotation, pos *mgl64.Vec3)
	HandleStartBreaking(ctx *Context, pos cube.Pos)
	HandleBreakBlock(ctx *Context, pos cube.Pos, block w.Block)
	HandleAttack(ctx *Context, entity world.Entity)
	HandleJump(ctx *Context)
}
