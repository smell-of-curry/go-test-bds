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
	// HandleTick is called every Actor's tick.
	HandleTick(actor *Actor, tick uint64)
	// HandleMove ...
	HandleMove(ctx *Context, rot *cube.Rotation, pos *mgl64.Vec3)
	// HandleInput handles Actor's input.
	HandleInput(ctx *Context, input *movement.Input)
	// HandleStartBreak handles Actor starting to break a block at the position passed.
	HandleStartBreak(ctx *Context, pos cube.Pos)
	// HandleBlockBreak handles a block that is being broken by the Actor.
	HandleBlockBreak(ctx *Context, pos cube.Pos, block w.Block)
	// HandleAbortBreaking ...
	HandleAbortBreaking(ctx *Context, pos cube.Pos)
	// HandleAttack handles the Actor attacking an entity.
	HandleAttack(ctx *Context, entity world.Entity)
	// HandleJump handles Actor jumping.
	HandleJump(ctx *Context)
	// HandleAddEffect ...
	HandleAddEffect(ctx *Context, eff effect.Effect)
	// HandleRemoveEffect ...
	HandleRemoveEffect(ctx *Context, eff effect.Type)
	// HandleUseItem ...
	HandleUseItem(ctx *Context, item item.Stack)
	// HandleUseItemOnBlock ...
	HandleUseItemOnBlock(ctx *Context, item item.Stack, pos cube.Pos)
	// HandleUseItemOnEntity ...
	HandleUseItemOnEntity(ctx *Context, item item.Stack, ent world.Entity)
	// HandleReleaseItem ...
	HandleReleaseItem(ctx *Context, item item.Stack)
	// HandleReceiveMessage ...
	HandleReceiveMessage(actor *Actor, msg string)
	// HandleReceiveForm handles Actor receiving Form.
	// If the form was not used and the ctx is not canceled, then the form will be ignored.
	HandleReceiveForm(ctx *Context, form *Form)
	// HandleReceiveSign handles Actor receiving Sign.
	HandleReceiveSign(actor *Actor, sign *Sign)
	// HandleReceiveDialogue handles Actor receiving Dialogue.
	// If the dialogue was not used and the ctx is not canceled, then the dialogue will be ignored.
	HandleReceiveDialogue(ctx *Context, dialogue *Dialogue)
	// HandleReachTarget ...
	HandleReachTarget(actor *Actor)
	// HandleStopNavigation ...
	HandleStopNavigation(actor *Actor)
}

var _ Handler = NopHandler{}

type NopHandler struct{}

func (NopHandler) HandleTick(actor *Actor, tick uint64)                                  {}
func (NopHandler) HandleMove(ctx *Context, rot *cube.Rotation, pos *mgl64.Vec3)          {}
func (NopHandler) HandleInput(ctx *Context, input *movement.Input)                       {}
func (NopHandler) HandleStartBreak(ctx *Context, pos cube.Pos)                           {}
func (NopHandler) HandleBlockBreak(ctx *Context, pos cube.Pos, block w.Block)            {}
func (NopHandler) HandleAbortBreaking(ctx *Context, pos cube.Pos)                        {}
func (NopHandler) HandleAttack(ctx *Context, entity world.Entity)                        {}
func (NopHandler) HandleJump(ctx *Context)                                               {}
func (NopHandler) HandleAddEffect(ctx *Context, eff effect.Effect)                       {}
func (NopHandler) HandleRemoveEffect(ctx *Context, eff effect.Type)                      {}
func (NopHandler) HandleUseItem(ctx *Context, item item.Stack)                           {}
func (NopHandler) HandleUseItemOnBlock(ctx *Context, item item.Stack, pos cube.Pos)      {}
func (NopHandler) HandleUseItemOnEntity(ctx *Context, item item.Stack, ent world.Entity) {}
func (NopHandler) HandleReleaseItem(ctx *Context, item item.Stack)                       {}
func (NopHandler) HandleReceiveMessage(actor *Actor, msg string)                         {}
func (NopHandler) HandleReceiveForm(ctx *Context, form *Form)                            {}
func (NopHandler) HandleReceiveSign(actor *Actor, sign *Sign)                            {}
func (NopHandler) HandleReceiveDialogue(ctx *Context, dialogue *Dialogue)                {}
func (NopHandler) HandleReachTarget(actor *Actor)                                        {}
func (NopHandler) HandleStopNavigation(actor *Actor)                                     {}
