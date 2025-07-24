package world

import (
	"github.com/df-mc/dragonfly/server/block/cube"
	"github.com/go-gl/mathgl/mgl64"
	"github.com/sandertv/gophertunnel/minecraft/protocol"
)

// Entity ...
type Entity interface {
	Position() mgl64.Vec3
	Rotation() cube.Rotation
	Velocity() mgl64.Vec3
	Meta() protocol.EntityMetadata
	RuntimeID() uint64
	Move(pos mgl64.Vec3, rot cube.Rotation)
	Type() string
}
