package world

import (
	"github.com/df-mc/dragonfly/server/block/cube"
	"github.com/go-gl/mathgl/mgl64"
	"github.com/smell-of-curry/go-test-bds/gotestbds/entity/attributes"
	"github.com/smell-of-curry/go-test-bds/gotestbds/entity/metadata"
)

// Entity ...
type Entity interface {
	Position() mgl64.Vec3
	Rotation() cube.Rotation
	Velocity() mgl64.Vec3
	SetVelocity(vel mgl64.Vec3)
	State() *metadata.State
	Attributes() *attributes.Values
	RuntimeID() uint64
	Move(pos mgl64.Vec3, rot cube.Rotation)
	Type() string
}
