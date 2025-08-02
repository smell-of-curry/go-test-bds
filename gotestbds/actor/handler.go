package actor

import (
	"github.com/df-mc/dragonfly/server/block/cube"
	"github.com/df-mc/dragonfly/server/entity/effect"
	"github.com/df-mc/dragonfly/server/event"
	"github.com/df-mc/dragonfly/server/item"
	w "github.com/df-mc/dragonfly/server/world"
	"github.com/go-gl/mathgl/mgl64"
	"github.com/smell-of-curry/go-test-bds/gotestbds/mcmath/physics/movement"
	"github.com/smell-of-curry/go-test-bds/gotestbds/world"
)

type Context = event.Context[*Actor]

type Handler interface {
	HandleTick(actor *Actor, tick uint64)
	HandleMove(ctx *Context, rot *cube.Rotation, pos *mgl64.Vec3)
	HandleInput(ctx *Context, input *movement.Input)
	HandleStartBreaking(ctx *Context, pos cube.Pos)
	HandleBreakBlock(ctx *Context, pos cube.Pos, block w.Block)
	HandleAttack(ctx *Context, entity world.Entity)
	HandleJump(ctx *Context)
	HandleAddEffect(ctx *Context, eff effect.Effect)
	HandleRemoveEffect(ctx *Context, eff effect.Type)
	HandleUseItem(ctx *Context, item item.Stack)
	HandleUseItemOnBlock(ctx *Context, item item.Stack, pos cube.Pos)
	HandleUseItemOnEntity(ctx *Context, item item.Stack, ent world.Entity)
	HandleReleaseItem(ctx *Context, item item.Stack)
	HandleReceiveMessage(msg string)
	HandleReachTarget(actor *Actor)
	HandleStopNavigation(actor *Actor)
}

var _ Handler = NopHandler{}

type NopHandler struct{}

func (n NopHandler) HandleTick(actor *Actor, tick uint64)                                  {}
func (n NopHandler) HandleMove(ctx *Context, rot *cube.Rotation, pos *mgl64.Vec3)          {}
func (n NopHandler) HandleInput(ctx *Context, input *movement.Input)                       {}
func (n NopHandler) HandleStartBreaking(ctx *Context, pos cube.Pos)                        {}
func (n NopHandler) HandleBreakBlock(ctx *Context, pos cube.Pos, block w.Block)            {}
func (n NopHandler) HandleAttack(ctx *Context, entity world.Entity)                        {}
func (n NopHandler) HandleJump(ctx *Context)                                               {}
func (n NopHandler) HandleAddEffect(ctx *Context, eff effect.Effect)                       {}
func (n NopHandler) HandleRemoveEffect(ctx *Context, eff effect.Type)                      {}
func (n NopHandler) HandleUseItem(ctx *Context, item item.Stack)                           {}
func (n NopHandler) HandleUseItemOnBlock(ctx *Context, item item.Stack, pos cube.Pos)      {}
func (n NopHandler) HandleUseItemOnEntity(ctx *Context, item item.Stack, ent world.Entity) {}
func (n NopHandler) HandleReleaseItem(ctx *Context, item item.Stack)                       {}
func (n NopHandler) HandleReceiveMessage(msg string)                                       {}
func (n NopHandler) HandleReachTarget(actor *Actor)                                        {}
func (n NopHandler) HandleStopNavigation(actor *Actor)                                     {}
