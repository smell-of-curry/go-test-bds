package world

import (
	"github.com/df-mc/dragonfly/server/block/cube"
	"github.com/df-mc/dragonfly/server/item"
	"github.com/go-gl/mathgl/mgl64"
	"github.com/smell-of-curry/go-test-bds/gotestbds/entity/attributes"
	"github.com/smell-of-curry/go-test-bds/gotestbds/entity/metadata"
	"github.com/smell-of-curry/go-test-bds/gotestbds/inventory"
)

// Entity represents minecraft entity.
type Entity interface {
	// Position returns position of the Entity.
	Position() mgl64.Vec3
	// Rotation returns rotation of the Entity.
	Rotation() cube.Rotation
	// Velocity returns Velocity of the entity.
	Velocity() mgl64.Vec3
	// SetVelocity sets Entity velocity.
	SetVelocity(vel mgl64.Vec3)
	// State returns metadata state of the entity.
	State() *metadata.State
	// Attributes returns Entity attributes (such as health, level etc...).
	Attributes() *attributes.Values
	// Armour returns Armour of the Entity.
	Armour() *inventory.Armour
	// HeldItems returns held items of the Entity.
	HeldItems() (main item.Stack, offHand item.Stack)
	// SetHeldItems sets Entity held items.
	SetHeldItems(main, offHand item.Stack) error
	// RuntimeID returns Entity runtime id.
	RuntimeID() uint64
	// Move moves Entity.
	Move(pos mgl64.Vec3, rot cube.Rotation)
	// Type returns Entity type.
	Type() string
}
