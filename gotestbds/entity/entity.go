package entity

import (
	"github.com/df-mc/dragonfly/server/block/cube"
	"github.com/df-mc/dragonfly/server/item"
	"github.com/go-gl/mathgl/mgl64"
	"github.com/sandertv/gophertunnel/minecraft/protocol"
	"github.com/smell-of-curry/go-test-bds/gotestbds/entity/attributes"
	"github.com/smell-of-curry/go-test-bds/gotestbds/entity/metadata"
	"github.com/smell-of-curry/go-test-bds/gotestbds/inventory"
)

// Ent is world.Entity implementation for simple entities.
type Ent struct {
	pos        mgl64.Vec3
	rot        cube.Rotation
	vel        mgl64.Vec3
	state      *metadata.State
	attributes *attributes.Values
	armour     *inventory.Armour
	mainHand   item.Stack
	offHand    item.Stack
	rid        uint64
	entityType string
}

// NewEnt ...
func NewEnt(pos mgl64.Vec3, meta protocol.EntityMetadata, rid uint64, entityType string) *Ent {
	state := new(metadata.State)
	state.Decode(meta)
	return &Ent{pos: pos, state: state, rid: rid, entityType: entityType, attributes: new(attributes.Values), armour: inventory.NewArmour(nil)}
}

// Position is a position of the entity.
func (e *Ent) Position() mgl64.Vec3 {
	return e.pos
}

// Rotation is a rotation of the entity.
func (e *Ent) Rotation() cube.Rotation {
	return e.rot
}

// Velocity is a move vector of the entity.
func (e *Ent) Velocity() mgl64.Vec3 {
	return e.vel
}

// SetVelocity ...
func (e *Ent) SetVelocity(vel mgl64.Vec3) {
	e.vel = vel
}

// State returns state of the entity.
func (e *Ent) State() *metadata.State {
	return e.state
}

// Attributes returns attribute values of the entity.
func (e *Ent) Attributes() *attributes.Values {
	return e.attributes
}

// RuntimeID is runtime identifier of the entity it identifies entity in the packets.
func (e *Ent) RuntimeID() uint64 {
	return e.rid
}

// Move ...
func (e *Ent) Move(pos mgl64.Vec3, rot cube.Rotation) {
	e.pos = pos
	e.rot = rot
}

// Type is a type of the entity it defines how player will see the entity (pig, sheep etc...).
func (e *Ent) Type() string {
	return e.entityType
}

// Armour returns armour.
func (e *Ent) Armour() *inventory.Armour {
	return e.armour
}

// HeldItems returns held items.
func (e *Ent) HeldItems() (main item.Stack, offHand item.Stack) {
	return e.mainHand, e.offHand
}

// SetHeldItems sets held items.
func (e *Ent) SetHeldItems(main, offHand item.Stack) error {
	e.mainHand, e.offHand = main, offHand
	return nil
}
