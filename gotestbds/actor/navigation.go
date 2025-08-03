package actor

import (
	pathfind "github.com/FDUTCH/Pathfinder"
	"github.com/FDUTCH/Pathfinder/evaluator"
	"github.com/df-mc/dragonfly/server/block/cube"
	"github.com/smell-of-curry/go-test-bds/gotestbds/mcmath/physics/movement"
)

// Navigate builds a path to the destination position.
func (a *Actor) Navigate(target cube.Pos) {
	cfg := evaluator.WalkNodeEvaluatorConfig{
		Box:          a.State().Box(),
		Pos:          a.Position(),
		CanPathDoors: true,
		CanOpenDoors: true,
	}
	pos := cube.PosFromVec3(a.Position())
	a.path = pathfind.FindPath(cfg.New(), a.world, pos, target, 400, 25, 1)
	a.navigationTarget = target
}

// Navigating returns whether Actor is navigating.
func (a *Actor) Navigating() bool {
	return a.path != nil
}

// tickNavigating ...
func (a *Actor) tickNavigating() {
	if !a.Navigating() {
		return
	}
	path := a.path
	destination := path.NextNode().Pos
	pos := cube.PosFromVec3(a.Position())

	if pos == destination {
		path.Advance()
	}

	if path.IsDone() {
		a.path = nil
		// creating continuation for the path.
		if !path.Reached() {
			a.Navigate(a.navigationTarget)
			// path has been re-created, but the Actor hasn't moved yet.
			a.tickNavigating()
			return
		}
		a.Handler().HandleReachTarget(a)
		return
	}

	input := movement.Input{Forward: true}
	if destination.Y() > pos.Y() {
		input.Jump = true
	}
	pitch := a.Rotation().Pitch()
	a.LookAtBlock(destination)
	previousPosition := a.Position()
	if !a.MoveRawInput(input, cube.Rotation{0, pitch - a.Rotation().Pitch()}) {
		return
	}

	// if Actor cannot move, the path must be re-created.
	if a.Position().ApproxEqual(previousPosition) {
		a.Navigate(a.navigationTarget)
		// I don't know if it's a good idea to call tickNavigating again.
	}
}

// StopNavigating stops Actor from navigating.
func (a *Actor) StopNavigating() {
	a.path = nil
	a.Handler().HandleStopNavigation(a)
}
