package physics

import (
	"math"
	"testing"
	"time"

	"github.com/df-mc/dragonfly/server/block"
	"github.com/df-mc/dragonfly/server/block/cube"
	"github.com/df-mc/dragonfly/server/world"
	"github.com/go-gl/mathgl/mgl64"
)

// airSource is a BlockSource that is all air — the worst case for a falling
// sweep, since nothing ever stops it.
type airSource struct{}

func (airSource) Block(cube.Pos) world.Block { return block.Air{} }

// playerBox mirrors the actor's bounding box.
func playerBox() cube.BBox {
	return cube.Box(-0.3, 0, -0.3, 0.3, 1.8, 0.3)
}

// TestTickMovementPoisonedVelocity guards the run-35 livelock: a NaN or
// astronomically large velocity must not make the collision sweep visit an
// unbounded block volume. Each tick has to return promptly with finite
// outputs.
func TestTickMovementPoisonedVelocity(t *testing.T) {
	c := &Computer{Gravity: 0.08, Drag: 0.02, DragBeforeGravity: true}
	poisoned := []mgl64.Vec3{
		{math.NaN(), math.NaN(), math.NaN()},
		{0, math.Inf(-1), 0},
		{0, -1.52e8, 0},
		{1e300, 5, -1e300},
	}
	for _, vel := range poisoned {
		done := make(chan *Movement, 1)
		go func() {
			done <- c.TickMovement(playerBox(), mgl64.Vec3{31, 83, -97}, vel, cube.Rotation{}, airSource{})
		}()
		select {
		case m := <-done:
			if !finiteVec(m.Position()) || !finiteVec(m.Velocity()) {
				t.Fatalf("vel %v: non-finite movement %v / %v", vel, m.Position(), m.Velocity())
			}
			for _, v := range m.Velocity() {
				if math.Abs(v) > maxVelocity {
					t.Fatalf("vel %v: velocity %v escaped the clamp", vel, m.Velocity())
				}
			}
		case <-time.After(5 * time.Second):
			t.Fatalf("vel %v: TickMovement did not return within 5s (unbounded sweep)", vel)
		}
	}
}

// TestTickMovementPoisonedPosition: a non-finite position freezes the mover
// instead of sweeping garbage bounds.
func TestTickMovementPoisonedPosition(t *testing.T) {
	c := &Computer{Gravity: 0.08, Drag: 0.02, DragBeforeGravity: true}
	done := make(chan *Movement, 1)
	go func() {
		done <- c.TickMovement(playerBox(), mgl64.Vec3{math.NaN(), 83, -97}, mgl64.Vec3{0, -1, 0}, cube.Rotation{}, airSource{})
	}()
	select {
	case m := <-done:
		if d := m.dpos; d != (mgl64.Vec3{}) {
			t.Fatalf("poisoned position still moved: %v", d)
		}
	case <-time.After(5 * time.Second):
		t.Fatal("TickMovement did not return within 5s")
	}
}
