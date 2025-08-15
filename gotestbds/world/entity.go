package world

import (
	"github.com/df-mc/dragonfly/server/block/cube"
	"github.com/df-mc/dragonfly/server/item"
	"github.com/go-gl/mathgl/mgl64"
	"github.com/smell-of-curry/go-test-bds/gotestbds/entity/attributes"
	"github.com/smell-of-curry/go-test-bds/gotestbds/entity/metadata"
	"github.com/smell-of-curry/go-test-bds/gotestbds/inventory"
)

// Entity ...
type Entity interface {
	Position() mgl64.Vec3
	Rotation() cube.Rotation
	Velocity() mgl64.Vec3
	SetVelocity(vel mgl64.Vec3)
	State() *metadata.State
	Attributes() *attributes.Values
	Armour() *inventory.Armour
	HeldItems() (main item.Stack, offHand item.Stack)
	SetHeldItems(main, offHand item.Stack) error
	RuntimeID() uint64
	Move(pos mgl64.Vec3, rot cube.Rotation)
	Type() string
}
