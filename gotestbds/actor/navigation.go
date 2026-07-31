package actor

import (
	"fmt"

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

	// emptyPathWaitTicks: when FindPath returns empty because the start
	// column is still requested/partial, keep retrying this long before
	// failing (10s at 20 Hz — same ballpark as the suite's waitForWorldAt).
	emptyPathWaitTicks = 200
)

// pathSource is the world as the pathfinder is allowed to see it.
//
// Missing columns AND columns that exist but are not ColumnComplete (LevelChunk
// arrived in sub-chunk request mode, blocks not yet filled) read as bedrock.
// Treating incomplete columns as "loaded air" — World.BlockAt's old behaviour —
// made WalkNodeEvaluator.StartNode descend through an empty air column to y=-64
// and FindPath return an empty path, so every navigateToBlock failed instantly
// with 0 progress while the suite logged "column never reached the client".
type pathSource struct{ w *world.World }

// Block returns the block at pos, or bedrock when the column is missing,
// incomplete, or pos is outside its vertical range.
//
// @param pos The block position.
// @returns the observed block, or bedrock for unobserved positions.
func (s pathSource) Block(pos cube.Pos) w.Block {
	c, ok := s.w.Chunk(w.ChunkPos{int32(pos[0] >> 4), int32(pos[2] >> 4)})
	if !ok || pos.OutOfBounds(c.Range()) || c.State != world.ColumnComplete {
		return block.Bedrock{}
	}
	return s.w.Block(pos)
}

// columnComplete reports whether the column covering pos has fully arrived.
//
// @param wr Bot world.
// @param pos Block position.
// @returns true when pathSource would see real blocks at pos.
func columnComplete(wr *world.World, pos cube.Pos) bool {
	c, ok := wr.Chunk(w.ChunkPos{int32(pos[0] >> 4), int32(pos[2] >> 4)})
	return ok && !pos.OutOfBounds(c.Range()) && c.State == world.ColumnComplete
}

// columnStateName returns a short label for diagnostics.
//
// @param wr Bot world.
// @param pos Block position.
// @returns "missing", "requested", "partial", or "complete".
func columnStateName(wr *world.World, pos cube.Pos) string {
	c, ok := wr.Chunk(w.ChunkPos{int32(pos[0] >> 4), int32(pos[2] >> 4)})
	if !ok {
		return "missing"
	}
	if pos.OutOfBounds(c.Range()) {
		return "oob"
	}
	return c.State.String()
}

// countUnknownNear counts UnknownBlock in the 3×3×3 neighbourhood of pos
// (pathSource-complete view: incomplete columns do not count as unknown).
//
// @param wr Bot world.
// @param pos Centre position.
// @returns number of UnknownBlock cells in the neighbourhood.
func countUnknownNear(wr *world.World, pos cube.Pos) int {
	n := 0
	for dx := -1; dx <= 1; dx++ {
		for dy := -1; dy <= 1; dy++ {
			for dz := -1; dz <= 1; dz++ {
				p := pos.Add(cube.Pos{dx, dy, dz})
				if !columnComplete(wr, p) {
					continue
				}
				if _, ok := wr.Block(p).(world.UnknownBlock); ok {
					n++
				}
			}
		}
	}
	return n
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
// such drop exists.
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

// clampGoalToObserved projects to onto the farthest complete column along the
// from→to line. Incomplete columns are treated as unseen (same as pathSource).
//
// @param wr Bot world.
// @param from Actor block position.
// @param to True destination.
// @returns to when its column is complete, otherwise the last complete block toward to.
func clampGoalToObserved(wr *world.World, from, to cube.Pos) cube.Pos {
	if columnComplete(wr, to) {
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
		if !columnComplete(wr, p) {
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

// NavFailureDetail is the one-line diagnostic attached to "unable to reach
// destination" so live showcase runs show why FindPath/fail-fast stopped.
//
// @returns empty when the last stop was not a navigation failure.
func (a *Actor) NavFailureDetail() string {
	return a.navFailDetail
}

// recordNavSnapshot stores diagnostic fields from the latest Navigate call.
func (a *Actor) recordNavSnapshot(target, goal, start cube.Pos, p *pathfind.Path, maxVisited int) {
	a.navLastTarget = target
	a.navLastGoal = goal
	a.navLastStart = start
	a.navLastPathCount = 0
	a.navLastReached = false
	if p != nil {
		a.navLastPathCount = p.Count()
		a.navLastReached = p.Reached()
	}
	a.navLastMaxVisited = maxVisited
	a.navLastStartState = columnStateName(a.world, start)
	a.navLastGoalState = columnStateName(a.world, target)
	a.navLastUnknownNear = countUnknownNear(a.world, start)
}

// formatNavFailure builds the diagnostic suffix for the instruction error.
//
// @param reason Short failure reason (empty_path, fruitless, etc.).
// @returns one-line detail.
func (a *Actor) formatNavFailure(reason string) string {
	clamped := ""
	if a.navLastGoal != a.navLastTarget {
		clamped = fmt.Sprintf(" clamped=%v", a.navLastGoal)
	}
	return fmt.Sprintf(
		"%s start=%v(%s) goal=%v(%s)%s pathNodes=%d reached=%v unknownNear=%d budgetVisited=%d fruitless=%d",
		reason,
		a.navLastStart, a.navLastStartState,
		a.navLastTarget, a.navLastGoalState,
		clamped,
		a.navLastPathCount, a.navLastReached,
		a.navLastUnknownNear, a.navLastMaxVisited,
		a.fruitlessRepaths,
	)
}

// failNavigation stops navigating and records why for the instruction error.
//
// @param reason Short failure reason.
func (a *Actor) failNavigation(reason string) {
	a.navFailDetail = a.formatNavFailure(reason)
	a.path = nil
	a.repathCooldown = 0
	a.fruitlessRepaths = 0
	a.emptyPathWaits = 0
	a.Handler().HandleStopNavigation(a)
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
	a.recordNavSnapshot(target, goal, start, p, maxVisited)
	a.path = p
	a.navigationTarget = target
	a.navFailDetail = ""
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
		start := cube.PosFromVec3(a.Position())
		// Incomplete start column: empty path is expected (pathSource=bedrock).
		// Retry until the column completes or the wait budget expires — do not
		// fire "unable to reach destination" on the first tick.
		if !columnComplete(a.world, start) {
			a.emptyPathWaits++
			if a.emptyPathWaits > emptyPathWaitTicks {
				a.failNavigation("empty_path_start_incomplete")
				return
			}
			if a.repathCooldown == 0 {
				a.Navigate(a.navigationTarget)
				a.repathCooldown = repathCooldownTicks
			}
			return
		}
		a.failNavigation("empty_path")
		return
	}

	a.emptyPathWaits = 0
	path := a.path
	pos := cube.PosFromVec3(a.Position())

	// Check done before NextNode: a continuation can leave the path already
	// exhausted at tick start (manual Advance in tests, or last tick's Advance).
	if !path.IsDone() && pos == path.NextNode().Pos {
		path.Advance()
	}

	if path.IsDone() {
		if distToNavTarget(a.Position(), a.navigationTarget) <= navArriveBlocks {
			a.path = nil
			a.fruitlessRepaths = 0
			a.emptyPathWaits = 0
			a.navFailDetail = ""
			a.Handler().HandleReachTarget(a)
			return
		}
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
// actor already is.
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
			reason := "fruitless_no_closer_path"
			if forceFruitless {
				reason = "fruitless_stuck"
			}
			a.failNavigation(reason)
			return
		}
		return
	}
	a.fruitlessRepaths = 0
	a.tickNavigating()
}

// StopNavigating stops Actor from navigating.
func (a *Actor) StopNavigating() {
	a.path = nil
	a.repathCooldown = 0
	a.fruitlessRepaths = 0
	a.emptyPathWaits = 0
	// Leave navFailDetail set when failNavigation already filled it; clear
	// only for external/timeout stops so a late false callback stays quiet.
	if a.navFailDetail == "" {
		a.navFailDetail = "stopped"
	}
	a.Handler().HandleStopNavigation(a)
}
