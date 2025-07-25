package mcmath

import (
	"github.com/df-mc/dragonfly/server/block/cube"
	"github.com/go-gl/mathgl/mgl32"
	"github.com/go-gl/mathgl/mgl64"
	"math"
)

// Vec32To64 ...
func Vec32To64(vec3 mgl32.Vec3) mgl64.Vec3 {
	return mgl64.Vec3{float64(vec3[0]), float64(vec3[1]), float64(vec3[2])}
}

// Vec64To32 ...
func Vec64To32(vec3 mgl64.Vec3) mgl32.Vec3 {
	return mgl32.Vec3{float32(vec3[0]), float32(vec3[1]), float32(vec3[2])}
}

// RotateVec2 rotates vec by yaw degrees.
func RotateVec2(vec mgl32.Vec2, yaw float32) mgl32.Vec2 {
	yawRad := float64(yaw * math.Pi / 180.0)

	sin, cos := float32(math.Sin(yawRad)), float32(math.Cos(yawRad))

	x := vec[0]*cos - vec[1]*sin
	y := vec[0]*sin + vec[1]*cos

	return mgl32.Vec2{x, y}
}

// VectorToRotation converts vector to the
func VectorToRotation(direction mgl64.Vec3) cube.Rotation {
	normalized := direction.Normalize()

	yaw := math.Atan2(normalized.Y(), normalized.X())
	xyDist := math.Sqrt(normalized.X()*normalized.X() + normalized.Y()*normalized.Y())
	pitch := math.Atan2(normalized.Z(), xyDist)

	return cube.Rotation{yaw, pitch}
}
