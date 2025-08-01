package movement

import "github.com/go-gl/mathgl/mgl64"

// Input simulates keystrokes.
type Input struct {
	Forward bool
	Back    bool
	Left    bool
	Right   bool
	Jump    bool
	Sneak   bool
}

// MoveVector calculates move vector from Input.
func (i Input) MoveVector() mgl64.Vec2 {
	f := calculateImpulse(i.Forward, i.Back)
	g := calculateImpulse(i.Left, i.Right)
	return mgl64.Vec2{g, f}
}

// calculateImpulse ...
func calculateImpulse(bl, bl2 bool) float64 {
	if bl == bl2 {
		return 0.0
	} else if bl {
		return 1.0
	}
	return -1.0
}
