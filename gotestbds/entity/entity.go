package entity

import (
	"github.com/df-mc/dragonfly/server/block/cube"
	"github.com/go-gl/mathgl/mgl64"
	"github.com/sandertv/gophertunnel/minecraft/protocol"
)

// Ent is world.Entity implementation for simple entities.
type Ent struct {
	pos        mgl64.Vec3
	rot        cube.Rotation
	meta       protocol.EntityMetadata
	rid        uint64
	entityType string
}

// NewEnt ...
func NewEnt(pos mgl64.Vec3, meta protocol.EntityMetadata, rid uint64, entityType string) *Ent {
	return &Ent{pos: pos, meta: meta, rid: rid, entityType: entityType}
}

// Position is a position of the entity.
func (e *Ent) Position() mgl64.Vec3 {
	return e.pos
}

// Rotation is a rotation of the entity.
func (e *Ent) Rotation() cube.Rotation {
	return e.rot
}

// Meta is a metadata of the entity it is storing entity state.
func (e *Ent) Meta() protocol.EntityMetadata {
	return e.meta
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
