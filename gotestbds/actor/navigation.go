package actor

import (
	pathfind "github.com/FDUTCH/Pathfinder"
	"github.com/FDUTCH/Pathfinder/evaluator"
	"github.com/df-mc/dragonfly/server/block"
	"github.com/df-mc/dragonfly/server/block/cube"
	w "github.com/df-mc/dragonfly/server/world"
	"github.com/go-gl/mathgl/mgl64"
	"github.com/smell-of-curry/go-test-bds/gotestbds/mcmath/physics/movement"
	"github.com/smell-of-curry/go-test-bds/gotestbds/world"
)

// Pathfind budget: old hardcoded (400 visited, 25 maxDistanceFromStart) could
// never reach a target beyond ~25 blocks and starved city terrain of nodes.
// Scale with straight-line distance; keep a hard cap so a single FindPath on
// the 20 Hz tick goroutine stays bounded (a few ms on open ground).
const (
	pathfindSlackBlocks     = 24  // detour allowance beyond euclidean distance
	pathfindVisitedPerBlock = 250 // ~grid expansions per block of distance
	pathfindVisitedBase     = 500 // floor so short hops still explore obstacles
	pathfindVisitedCap      = 12000
	repathCooldownTicks     = 10 // re-FindPath at most every 0.5s when stuck
	fruitlessRepathLimit    = 3  // stop after this many no-progress re-paths

	// maxSafeFallBlocks is the deepest single drop we allow on a path.
	// Stair/terrain drops of 1–4 blocks stay fine; deeper pits must be walked
	// around (or fail as unreachable).
	maxSafeFallBlocks = 4

	// walkMaxFallDistance is WalkNodeEvaluatorConfig.MaxFallDistance. The lib
	// rejects when fallDistance >= this value, so maxSafeFallBlocks+1 allows
	// drops of at most maxSafeFallBlocks.
	walkMaxFallDistance = maxSafeFallBlocks + 1
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

// pathfindBudget returns FindPath limits for a straight-line distance.
//
// @param dist Euclidean actor-to-target distance in blocks.
// @returns maxVisitedNodes and maxDistanceFromStart for FindPath.
func pathfindBudget(dist float64) (maxVisited int, maxDistanceFromStart float64) {
	if dist < 0 {
		dist = 0
	}
	maxDistanceFromStart = dist + pathfindSlackBlocks
	maxVisited = pathfindVisitedBase + pathfindVisitedPerBlock*int(dist)
	if maxVisited > pathfindVisitedCap {
		maxVisited = pathfindVisitedCap
	}
	return maxVisited, maxDistanceFromStart
}

// walkEvaluatorConfig returns the WalkNodeEvaluator settings used for bot
// navigation. CanFloat must be true: with the lib default (false), AcceptedNode
// early-returns OPEN nodes over air voids before MaxFallDistance runs, so
// paths bridge pits and the bot falls in while following.
//
// @param box Entity collision box.
// @param pos Entity feet position.
// @returns config for evaluator.WalkNodeEvaluatorConfig.New.
func walkEvaluatorConfig(box cube.BBox, pos mgl64.Vec3) evaluator.WalkNodeEvaluatorConfig {
	return evaluator.WalkNodeEvaluatorConfig{
		Box:             box,
		Pos:             pos,
		CanPathDoors:    true,
		CanOpenDoors:    true,
		CanFloat:        true,
		MaxFallDistance: walkMaxFallDistance,
	}
}

// pathHasExcessiveFall reports whether any single step in p drops more than
// maxDrop blocks (lib seam belt-and-suspenders).
//
// @param p Computed path.
// @param maxDrop Maximum allowed Y drop between consecutive nodes.
// @returns true if a deeper drop is present.
func pathHasExcessiveFall(p *pathfind.Path, maxDrop int) bool {
	if p == nil {
		return false
	}
	for i := 1; i < p.Count(); i++ {
		if p.Node(i-1).Y()-p.Node(i).Y() > maxDrop {
			return true
		}
	}
	return false
}

// Navigate builds a path to the destination position.
func (a *Actor) Navigate(target cube.Pos) {
	cfg := walkEvaluatorConfig(a.State().Box(), a.Position())
	pos := cube.PosFromVec3(a.Position())
	dist := a.Position().Sub(target.Vec3()).Len()
	maxVisited, maxDist := pathfindBudget(dist)
	p := pathfind.FindPath(cfg.New(), pathSource{a.world}, pos, target, maxVisited, maxDist, 1)
	if pathHasExcessiveFall(p, maxSafeFallBlocks) {
		// Treat as unreachable so recovery teleport can take over immediately.
		p = pathfind.NewPath(nil, false, target)
	}
	a.path = p
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

	if a.repathCooldown > 0 {
		a.repathCooldown--
	}

	if a.path.Count() == 0 {
		a.StopNavigating()
		return
	}

	path := a.path
	pos := cube.PosFromVec3(a.Position())

	// Check done before NextNode: a continuation can leave the path already
	// exhausted at tick start (manual Advance in tests, or last tick's Advance).
	if !path.IsDone() && pos == path.NextNode().Pos {
		path.Advance()
	}

	if path.IsDone() {
		// Partial path finished without reaching the goal (e.g. target only
		// reachable by falling into a pit). Count as fruitless so we fail fast
		// instead of re-pathing forever around the rim; real progress while
		// walking the previous segment already reset fruitlessRepaths.
		if !path.Reached() {
			a.repathTowardTarget(true)
			return
		}
		a.path = nil
		a.fruitlessRepaths = 0
		a.Handler().HandleReachTarget(a)
		return
	}

	destination := path.NextNode().Pos

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
		a.repathTowardTarget(true)
		return
	}
	a.fruitlessRepaths = 0
}

// repathTowardTarget runs FindPath again, throttled and fail-fast when stuck.
//
// @param fruitless When true, this re-path follows a no-movement tick and
// counts toward the fruitless limit. When false (partial-path continuation
// after walking), the counter resets — progress was already made.
func (a *Actor) repathTowardTarget(fruitless bool) {
	if a.repathCooldown > 0 {
		return
	}
	if fruitless {
		a.fruitlessRepaths++
		if a.fruitlessRepaths >= fruitlessRepathLimit {
			a.StopNavigating()
			return
		}
	} else {
		a.fruitlessRepaths = 0
	}
	a.Navigate(a.navigationTarget)
	a.repathCooldown = repathCooldownTicks
	if fruitless {
		return
	}
	// Continuation: start following the new path this tick.
	a.tickNavigating()
}

// StopNavigating stops Actor from navigating.
func (a *Actor) StopNavigating() {
	a.path = nil
	a.repathCooldown = 0
	a.fruitlessRepaths = 0
	a.Handler().HandleStopNavigation(a)
}
