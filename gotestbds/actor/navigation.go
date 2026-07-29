package actor

import (
	pathfind "github.com/FDUTCH/Pathfinder"
	"github.com/FDUTCH/Pathfinder/evaluator"
	"github.com/df-mc/dragonfly/server/block"
	"github.com/df-mc/dragonfly/server/block/cube"
	w "github.com/df-mc/dragonfly/server/world"
	"github.com/smell-of-curry/go-test-bds/gotestbds/mcmath/physics/movement"
	"github.com/smell-of-curry/go-test-bds/gotestbds/world"
)

// pathSource is the world as the pathfinder is allowed to see it: positions
// the server has not sent (missing columns, out-of-range Y) read as solid
// bedrock instead of air.
//
// World.Block's air-for-unloaded default keeps physics alive, but it fed the
// pathfinder's ground scans an infinite column of air: WalkNodeEvaluator's
// StartNode descends from the actor while the block reads as air, and its
// `air || pathfindable && y > -64` condition never bounds the air branch, so
// one Navigate() from an unloaded column spun the tick loop through
// world.Block at y=-152M until the process was killed (runs 35/36 — the
// walking showcase prunes and reloads columns constantly). Solid unseen
// terrain both terminates every scan and stops paths through terrain the bot
// has never observed.
type pathSource struct{ w *world.World }

// Block returns the block at pos, or bedrock when the column covering pos has
// not reached the client (or pos is outside the column's vertical range).
//
// @param pos The block position.
// @returns the observed block, or bedrock for unobserved positions.
func (s pathSource) Block(pos cube.Pos) w.Block {
	bl, ok := s.w.BlockAt(pos)
	if !ok {
		return block.Bedrock{}
	}
	return bl
}

// Navigate builds a path to the destination position.
func (a *Actor) Navigate(target cube.Pos) {
	cfg := evaluator.WalkNodeEvaluatorConfig{
		Box:          a.State().Box(),
		Pos:          a.Position(),
		CanPathDoors: true,
		CanOpenDoors: true,
	}
	pos := cube.PosFromVec3(a.Position())
	a.path = pathfind.FindPath(cfg.New(), pathSource{a.world}, pos, target, 400, 25, 1)
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

	if a.path.Count() == 0 {
		a.StopNavigating()
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
