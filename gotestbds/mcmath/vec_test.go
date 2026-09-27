package mcmath

import (
	"math"
	"testing"

	"github.com/go-gl/mathgl/mgl64"
)

func TestVectorToRotationUsesClientYawRange(t *testing.T) {
	tests := []struct {
		name string
		dir  mgl64.Vec3
		yaw  float64
	}{
		{name: "south", dir: mgl64.Vec3{0, 0, 1}, yaw: 0},
		{name: "west", dir: mgl64.Vec3{-1, 0, 0}, yaw: 90},
		{name: "north", dir: mgl64.Vec3{0, 0, -1}, yaw: -180},
		{name: "east", dir: mgl64.Vec3{1, 0, 0}, yaw: -90},
	}
	for _, test := range tests {
		t.Run(test.name, func(t *testing.T) {
			rotation := VectorToRotation(test.dir)
			if rotation.Yaw() != test.yaw {
				t.Fatalf("yaw = %v, want %v", rotation.Yaw(), test.yaw)
			}
			if rotation.Vec3().Sub(test.dir).Len() > 1e-9 {
				t.Fatalf("direction = %v, want %v", rotation.Vec3(), test.dir)
			}
			if math.Abs(rotation.Pitch()) > 1e-9 {
				t.Fatalf("pitch = %v, want 0", rotation.Pitch())
			}
		})
	}
}
