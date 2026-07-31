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

	// navArriveBlocks: feet within this of the true target counts as arrived
	// (path.Reached may refer to a clamped intermediate goal only).
	navArriveBlocks = 1.5

	// navProgressEps: a re-path must shorten remaining distance by at least
	// this much to count as useful (else fruitless).
	navProgressEps = 0.5
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

// truncatePathBeforeFall keeps the walkable prefix of p up to (but not
// including) the first drop deeper than maxDrop. Returns p unchanged when no
// such drop exists. Never returns an "unreachable" empty wipe — an empty wipe
// made every city leg with a single deep step fail instantly with zero walking
// (run-pr-704 showcase).
//
// @param p Computed path.
// @param maxDrop Maximum allowed Y drop between consecutive nodes.
// @param target True navigation target (stored on the rebuilt path).
// @returns p, or a truncated non-Reached path ending before the fall.
func truncatePathBeforeFall(p *pathfind.Path, maxDrop int, target cube.Pos) *pathfind.Path {
	if p == nil || p.Count() == 0 {
		return p
	}
	cut := p.Count()
	for i := 1; i < p.Count(); i++ {
		if p.Node(i-1).Y()-p.Node(i).Y() > maxDrop {
			cut = i
			break
		}
	}
	if cut == p.Count() {
		return p
	}
	nodes := make([]*pathfind.Node, cut)
	for i := 0; i < cut; i++ {
		nodes[i] = p.Node(i)
	}
	return pathfind.NewPath(nodes, false, target)
}

// absInt returns the absolute value of n.
//
// @param n Integer value.
// @returns |n|.
func absInt(n int) int {
	if n < 0 {
		return -n
	}
	return n
}

// clampGoalToObserved projects to onto the farthest loaded column along the
// from→to line. Unloaded space reads as bedrock to the pathfinder, so aiming
// FindPath at a far unloaded block yields either an empty path or a rim path
// that fail-fast used to discard; clamping makes the partial leg explicit.
//
// @param wr Bot world.
// @param from Actor block position.
// @param to True destination.
// @returns to when loaded, otherwise the last loaded block toward to.
func clampGoalToObserved(wr *world.World, from, to cube.Pos) cube.Pos {
	if wr.Loaded(to) {
		return to
	}
	dx, dy, dz := to.X()-from.X(), to.Y()-from.Y(), to.Z()-from.Z()
	steps := absInt(dx)
	if absInt(dy) > steps {
		steps = absInt(dy)
	}
	if absInt(dz) > steps {
		steps = absInt(dz)
	}
	if steps == 0 {
		return from
	}
	best := from
	for i := 1; i <= steps; i++ {
		p := cube.Pos{
			from.X() + dx*i/steps,
			from.Y() + dy*i/steps,
			from.Z() + dz*i/steps,
		}
		if !wr.Loaded(p) {
			break
		}
		best = p
	}
	return best
}

// distToNavTarget returns Euclidean distance from pos to the block centre of
// target.
//
// @param pos Feet position.
// @param target Block position.
// @returns distance in blocks.
func distToNavTarget(pos mgl64.Vec3, target cube.Pos) float64 {
	return pos.Sub(target.Vec3Centre()).Len()
}

// Navigate builds a path to the destination position.
func (a *Actor) Navigate(target cube.Pos) {
	start := cube.PosFromVec3(a.Position())
	goal := clampGoalToObserved(a.world, start, target)
	cfg := walkEvaluatorConfig(a.State().Box(), a.Position())
	dist := a.Position().Sub(goal.Vec3()).Len()
	maxVisited, maxDist := pathfindBudget(dist)
	p := pathfind.FindPath(cfg.New(), pathSource{a.world}, start, goal, maxVisited, maxDist, 1)
	if pathHasExcessiveFall(p, maxSafeFallBlocks) {
		p = truncatePathBeforeFall(p, maxSafeFallBlocks, target)
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
		// Arrived at the true target (path.Reached may only mean a clamped
		// intermediate goal inside the loaded view).
		if distToNavTarget(a.Position(), a.navigationTarget) <= navArriveBlocks {
			a.path = nil
			a.fruitlessRepaths = 0
			a.Handler().HandleReachTarget(a)
			return
		}
		// Partial leg finished (edge of loaded view, rim of a pit, clamped
		// goal). Repath toward the true target — not fruitless by itself;
		// repathTowardTarget only fails when the new path cannot get closer.
		a.repathTowardTarget(false)
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
// @param forceFruitless When true (no-movement tick), always counts toward the
// fruitless limit. When false (partial-leg finished), the counter only
// advances if the new path cannot get closer to the true target than the
// actor already is — so walking to the loaded rim then re-pathing is progress,
// not an instant "unable to reach destination".
func (a *Actor) repathTowardTarget(forceFruitless bool) {
	if a.repathCooldown > 0 {
		return
	}
	before := distToNavTarget(a.Position(), a.navigationTarget)
	a.Navigate(a.navigationTarget)
	a.repathCooldown = repathCooldownTicks

	useful := false
	if a.path != nil && a.path.Count() > 0 {
		if end := a.path.EndNode(); end != nil {
			useful = distToNavTarget(end.Pos.Vec3Centre(), a.navigationTarget) < before-navProgressEps
		}
	}
	if forceFruitless || !useful {
		a.fruitlessRepaths++
		if a.fruitlessRepaths >= fruitlessRepathLimit {
			a.StopNavigating()
			return
		}
		return
	}
	a.fruitlessRepaths = 0
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
