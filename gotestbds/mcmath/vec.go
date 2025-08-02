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
func RotateVec2(vec mgl64.Vec2, yaw float64) mgl64.Vec2 {
	yawRad := yaw * math.Pi / 180.0

	sin, cos := math.Sin(yawRad), math.Cos(yawRad)

	x := vec[0]*cos - vec[1]*sin
	y := vec[0]*sin + vec[1]*cos

	return mgl64.Vec2{x, y}
}

// VectorToRotation converts vector to the
func VectorToRotation(direction mgl64.Vec3) cube.Rotation {
	// Нормализуем вектор направления (если он не нулевой)
	if direction.Len() == 0 {
		return cube.Rotation{}
	}
	dir := direction.Normalize()

	horizontal := math.Sqrt(dir.X()*dir.X() + dir.Z()*dir.Z())

	pitch := -math.Atan2(dir.Y(), horizontal) * 180 / math.Pi

	yaw := math.Atan2(dir.Z(), dir.X())*180/math.Pi - 90
	if yaw < 0 {
		yaw += 360.0
	}

	return cube.Rotation{yaw, pitch}
}
