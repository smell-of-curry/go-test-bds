package actor

import (
	"strings"
	"testing"
	"time"

	pathfind "github.com/FDUTCH/Pathfinder"
	"github.com/df-mc/dragonfly/server/block"
	"github.com/df-mc/dragonfly/server/block/cube"
	dfworld "github.com/df-mc/dragonfly/server/world"
	"github.com/df-mc/dragonfly/server/world/chunk"
	"github.com/go-gl/mathgl/mgl32"
	"github.com/go-gl/mathgl/mgl64"
	"github.com/sandertv/gophertunnel/minecraft"
	"github.com/sandertv/gophertunnel/minecraft/protocol/login"
	"github.com/sandertv/gophertunnel/minecraft/protocol/packet"
	"github.com/smell-of-curry/go-test-bds/gotestbds/world"
)

// TestPathSourceSolidWhenUnloaded: unobserved positions read as bedrock, so
// pathfinder scans terminate and paths cannot cross unseen terrain.
func TestPathSourceSolidWhenUnloaded(t *testing.T) {
	src := pathSource{w: world.NewWorld(true)}
	if _, ok := src.Block(cube.Pos{31, 83, -97}).(block.Bedrock); !ok {
		t.Fatal("unloaded column should read as bedrock for the pathfinder")
	}
	if _, ok := src.Block(cube.Pos{31, -152_000_000, -97}).(block.Bedrock); !ok {
		t.Fatal("out-of-range Y should read as bedrock for the pathfinder")
	}
}

// TestPathSourceSolidWhenIncomplete: a LevelChunk that arrived in request mode
// leaves an empty air column until sub-chunks land. Pathfinding must not treat
// that air as walkable terrain (StartNode would descend to y=-64 and every
// navigateToBlock would fail instantly — live showcase regression).
func TestPathSourceSolidWhenIncomplete(t *testing.T) {
	w := world.NewWorld(false)
	dfworld.DefaultBlockRegistry.Finalize()
	col := world.NewColumn(chunk.New(dfworld.DefaultBlockRegistry, dfworld.Overworld.Range()), nil)
	col.ExpectSubChunks(4) // flips State to ColumnRequested
	w.AddChunk(dfworld.ChunkPos{0, 0}, col)

	src := pathSource{w: w}
	pos := cube.Pos{1, 64, 1}
	if _, ok := src.Block(pos).(block.Bedrock); !ok {
		t.Fatalf("incomplete column should read as bedrock for the pathfinder, got %T", src.Block(pos))
	}
	// World.Block still returns air (physics) — only the pathfinder is gated.
	if _, air := w.Block(pos).(block.Air); !air {
		t.Fatalf("World.Block should still be air for incomplete columns, got %T", w.Block(pos))
	}
}

// TestNavigateIncompleteStartWaitsThenFails: empty path while the start column
// is requested must not StopNavigating on tick 1; after emptyPathWaitTicks it
// fails with a diagnostic naming the incomplete start.
func TestNavigateIncompleteStartWaitsThenFails(t *testing.T) {
	const floorY = 64
	a := Config{Conn: navStubConn{pos: mgl32.Vec3{0.5, float32(floorY + 1), 0.5}}}.New()
	dfworld.DefaultBlockRegistry.Finalize()
	col := world.NewColumn(chunk.New(dfworld.DefaultBlockRegistry, dfworld.Overworld.Range()), nil)
	col.ExpectSubChunks(4)
	a.World().AddChunk(dfworld.ChunkPos{0, 0}, col)

	h := &navStopCounter{}
	a.Handle(h)
	a.Navigate(cube.Pos{8, floorY + 1, 0})
	if !a.Navigating() {
		t.Fatal("Navigate should keep a (possibly empty) path while waiting")
	}

	// First few ticks must not fail-fast.
	for i := 0; i < 5; i++ {
		a.Tick()
		if h.stopped != 0 {
			t.Fatalf("stopped on tick %d (detail=%q)", i, a.NavFailureDetail())
		}
	}

	for i := 0; i < emptyPathWaitTicks+repathCooldownTicks+5 && h.stopped == 0; i++ {
		a.Tick()
	}
	if h.stopped == 0 {
		t.Fatal("expected fail after emptyPathWaitTicks with incomplete start")
	}
	detail := a.NavFailureDetail()
	if detail == "" || !containsAll(detail, "empty_path_start_incomplete", "requested") {
		t.Fatalf("diagnostic=%q, want empty_path_start_incomplete + requested", detail)
	}
}

func containsAll(s string, parts ...string) bool {
	for _, p := range parts {
		if !strings.Contains(s, p) {
			return false
		}
	}
	return true
}

// TestAtPathNodeAllowsYSlack: path Advance must accept ±1 Y (feet block vs
// standable node Y), or navigation never leaves the first node.
func TestAtPathNodeAllowsYSlack(t *testing.T) {
	if !atPathNode(cube.Pos{3, 84, 5}, cube.Pos{3, 83, 5}) {
		t.Fatal("Y off by 1 should still count as at path node")
	}
	if atPathNode(cube.Pos{3, 84, 5}, cube.Pos{3, 83, 6}) {
		t.Fatal("different Z must not match")
	}
	if atPathNode(cube.Pos{3, 86, 5}, cube.Pos{3, 83, 5}) {
		t.Fatal("Y off by 3 must not match")
	}
}

// TestNavigateEmptyReachedIsSuccess: FindPath empty+Reached (start already in
// reachRange) must fire HandleReachTarget, not empty_path fail — otherwise
// every 1-block stride after resolveStandable hop-teleports (live 18e00ad).
func TestNavigateEmptyReachedIsSuccess(t *testing.T) {
	const floorY = 64
	a := Config{Conn: navStubConn{pos: mgl32.Vec3{0.5, float32(floorY + 1), 0.5}}}.New()
	fillFlatFloor(a.World(), -2, 4, 0, floorY)

	h := &navReachCounter{}
	a.Handle(h)
	// Goal is the block the bot already occupies — FindPath reachRange=1.
	a.Navigate(cube.Pos{0, floorY + 1, 0})
	if !a.Navigating() {
		t.Fatal("expected a path handle after Navigate")
	}
	a.Tick()
	if h.reached == 0 {
		t.Fatalf("empty+Reached should succeed, detail=%q stopped=%d", a.NavFailureDetail(), h.stopped)
	}
	if a.Navigating() {
		t.Fatal("should not still be navigating after reach")
	}
}

type navReachCounter struct {
	NopHandler
	reached int
	stopped int
}

func (h *navReachCounter) HandleReachTarget(*Actor)    { h.reached++ }
func (h *navReachCounter) HandleStopNavigation(*Actor) { h.stopped++ }

// TestNavigateIncompleteNeighborWaits: start column complete but the 3×3
// neighbourhood still requested must not empty_path-fail on tick 1 — those
// neighbours read as bedrock and trap FindPath in a one-cell pocket (live
// a5ab5fa: every walk leg 0 progress while only the bot's column had landed).
func TestNavigateIncompleteNeighborWaits(t *testing.T) {
	const floorY = 64
	a := Config{Conn: navStubConn{pos: mgl32.Vec3{8.5, float32(floorY + 1), 8.5}}}.New()
	dfworld.DefaultBlockRegistry.Finalize()

	// 3×3 columns: centre complete with floor; others requested/empty.
	for cx := int32(-1); cx <= 1; cx++ {
		for cz := int32(-1); cz <= 1; cz++ {
			col := world.NewColumn(chunk.New(dfworld.DefaultBlockRegistry, dfworld.Overworld.Range()), nil)
			if cx != 0 || cz != 0 {
				col.ExpectSubChunks(4)
			}
			a.World().AddChunk(dfworld.ChunkPos{cx, cz}, col)
		}
	}
	for x := 0; x < 16; x++ {
		for z := 0; z < 16; z++ {
			a.World().SetBlock(cube.Pos{x, floorY, z}, block.Stone{})
		}
	}

	h := &navStopCounter{}
	a.Handle(h)
	a.Navigate(cube.Pos{24, floorY + 1, 8}) // into neighbour column
	for i := 0; i < 5; i++ {
		a.Tick()
		if h.stopped != 0 {
			t.Fatalf("stopped on tick %d detail=%q (neighbourhood still incomplete)", i, a.NavFailureDetail())
		}
	}
}

// TestPathSourceSanitizesNilShulkerProgress mirrors the live 102016f panic:
// a palette-decoded ShulkerBox has progress==nil, Model() nil-derefs, and
// FindPath used to SIGSEGV the bot. pathSource must swap it for UnknownBlock
// and FindPath must complete.
func TestPathSourceSanitizesNilShulkerProgress(t *testing.T) {
	w := world.NewWorld(false)
	const floorY = 64
	fillFlatFloor(w, -2, 16, 0, floorY)
	// Zero-value ShulkerBox (nil progress) — same shape as network decode.
	shulkerPos := cube.Pos{2, floorY + 1, 0}
	w.SetBlock(shulkerPos, block.ShulkerBox{})

	src := pathSource{w: w}
	got := src.Block(shulkerPos)
	if _, ok := got.(world.UnknownBlock); !ok {
		// Round-trip via SetBlock may re-init; also accept if Model is already safe.
		if blockModelCallable(got) {
			t.Logf("SetBlock round-trip produced callable %T; probing zero-value directly", got)
		} else {
			t.Fatalf("pathSource.Block=%T, want UnknownBlock for unsafe shulker", got)
		}
	}
	if safe := safePathBlock(block.ShulkerBox{}); !blockModelCallable(safe) {
		t.Fatal("safePathBlock(zero ShulkerBox) still unsafe")
	}
	if _, ok := safePathBlock(block.ShulkerBox{}).(world.UnknownBlock); !ok {
		t.Fatalf("safePathBlock(zero ShulkerBox)=%T, want UnknownBlock", safePathBlock(block.ShulkerBox{}))
	}

	start := cube.Pos{0, floorY + 1, 0}
	target := cube.Pos{12, floorY + 1, 0}
	feet := start.Vec3().Add(mgl64.Vec3{0.5, 0, 0.5})
	cfg := walkEvaluatorConfig(cube.Box(-0.3, 0, -0.3, 0.3, 1.8, 0.3), feet)
	// Place unsafe shulker in the expansion neighbourhood even if SetBlock
	// sanitized storage — override via direct column write of the Go value
	// is hard; instead call FindPath against a source that always returns
	// the zero shulker at one neighbour. Use pathSource which already
	// sanitizes: if SetBlock stored a NewShulkerBox-like value, still ensure
	// findPathSafe recovers from a deliberate panic source.
	defer func() {
		if r := recover(); r != nil {
			t.Fatalf("FindPath panicked: %v", r)
		}
	}()
	path := findPathSafe(cfg.New(), src, start, target, 2000, 40)
	if path == nil {
		t.Fatal("findPathSafe returned nil")
	}
}

// panicBlockSource returns a zero ShulkerBox everywhere — FindPath must not
// kill the process when wrapped by findPathSafe.
type panicBlockSource struct{}

func (panicBlockSource) Block(cube.Pos) dfworld.Block {
	return block.ShulkerBox{}
}

// TestFindPathSafeRecoversShulkerPanic: findPathSafe must return empty path,
// not crash, when every Block is an unsafe ShulkerBox.
func TestFindPathSafeRecoversShulkerPanic(t *testing.T) {
	cfg := walkEvaluatorConfig(
		cube.Box(-0.3, 0, -0.3, 0.3, 1.8, 0.3),
		mgl64.Vec3{0.5, 65, 0.5},
	)
	defer func() {
		if r := recover(); r != nil {
			t.Fatalf("findPathSafe leaked panic: %v", r)
		}
	}()
	p := findPathSafe(cfg.New(), panicBlockSource{}, cube.Pos{0, 65, 0}, cube.Pos{8, 65, 0}, 400, 25)
	if p == nil {
		t.Fatal("nil path")
	}
	if p.Count() != 0 {
		t.Fatalf("expected empty recovered path, got count=%d", p.Count())
	}
}

// TestFindPathUnloadedWorldTerminates guards the run-35/36 livelock: FindPath
// starting from an unloaded column must return promptly instead of descending
// through an infinite column of air (WalkNodeEvaluator.StartNode's air branch
// is not Y-bounded).
func TestFindPathUnloadedWorldTerminates(t *testing.T) {
	src := pathSource{w: world.NewWorld(true)}
	cfg := walkEvaluatorConfig(
		cube.Box(-0.3, 0, -0.3, 0.3, 1.8, 0.3),
		mgl64.Vec3{31, 83, -97},
	)
	done := make(chan struct{})
	go func() {
		pathfind.FindPath(cfg.New(), src, cube.Pos{31, 83, -97}, cube.Pos{103, 83, 109}, 400, 25, 1)
		close(done)
	}()
	select {
	case <-done:
	case <-time.After(10 * time.Second):
		t.Fatal("FindPath did not return within 10s on an unloaded world")
	}
}

type navStubConn struct {
	pos mgl32.Vec3
}

func (c navStubConn) IdentityData() login.IdentityData {
	return login.IdentityData{
		Identity:    "00000000-0000-0000-0000-000000000001",
		DisplayName: "NavBot",
	}
}
func (navStubConn) WritePacket(packet.Packet) error { return nil }
func (c navStubConn) GameData() minecraft.GameData {
	return minecraft.GameData{
		EntityRuntimeID: 1,
		EntityUniqueID:  1,
		ChunkRadius:     8,
		PlayerPosition:  c.pos,
	}
}

// ensureChunks loads empty columns covering [minX,maxX]×[minZ,maxZ].
func ensureChunks(w *world.World, minX, maxX, minZ, maxZ int) {
	dfworld.DefaultBlockRegistry.Finalize()
	for cx := int32(minX >> 4); cx <= int32(maxX>>4); cx++ {
		for cz := int32(minZ >> 4); cz <= int32(maxZ>>4); cz++ {
			if _, ok := w.Chunk(dfworld.ChunkPos{cx, cz}); ok {
				continue
			}
			w.AddChunk(
				dfworld.ChunkPos{cx, cz},
				world.NewColumn(chunk.New(dfworld.DefaultBlockRegistry, dfworld.Overworld.Range()), nil),
			)
		}
	}
}

// fillFlatFloor loads columns and a stone floor from minX..maxX at floorY,
// with a 3-wide strip on Z so the pathfinder/physics hitbox has ground.
func fillFlatFloor(w *world.World, minX, maxX, z, floorY int) {
	ensureChunks(w, minX, maxX, z-1, z+1)
	for x := minX; x <= maxX; x++ {
		for dz := -1; dz <= 1; dz++ {
			w.SetBlock(cube.Pos{x, floorY, z + dz}, block.Stone{})
		}
	}
}

// digPit removes floorY down through depth blocks in [x0,x1]×[z0,z1], leaving
// stone at the pit bottom.
func digPit(w *world.World, x0, x1, z0, z1, floorY, depth int) {
	for x := x0; x <= x1; x++ {
		for z := z0; z <= z1; z++ {
			for y := floorY; y > floorY-depth; y-- {
				w.SetBlock(cube.Pos{x, y, z}, block.Air{})
			}
			w.SetBlock(cube.Pos{x, floorY - depth, z}, block.Stone{})
		}
	}
}

// TestFindPathLongFlatReachable is the regression the old maxDistanceFromStart=25
// made impossible: on open flat ground a 80-block target must be Reached with a
// non-empty path under the scaled budget.
func TestFindPathLongFlatReachable(t *testing.T) {
	w := world.NewWorld(false)
	const floorY = 64
	start := cube.Pos{0, floorY + 1, 0}
	target := cube.Pos{80, floorY + 1, 0}
	fillFlatFloor(w, -2, 82, 0, floorY)

	src := pathSource{w: w}
	feet := start.Vec3().Add(mgl64.Vec3{0.5, 0, 0.5})
	cfg := walkEvaluatorConfig(cube.Box(-0.3, 0, -0.3, 0.3, 1.8, 0.3), feet)
	dist := feet.Sub(target.Vec3()).Len()
	maxVisited, maxDist := pathfindBudget(dist)
	path := pathfind.FindPath(cfg.New(), src, start, target, maxVisited, maxDist, 1)
	if path.Count() == 0 {
		t.Fatal("scaled FindPath returned empty path on open flat ground")
	}
	if !path.Reached() {
		end := path.EndNode()
		t.Fatalf("80-block flat path not Reached (old budget 25 blocked this); end=%v distToTarget=%v", end, path.DistanceToTarget())
	}
	end := path.EndNode()
	if end.Vec3().Sub(start.Vec3()).Len() < 60 {
		t.Fatalf("path end %v not meaningfully closer to target than start", end)
	}
}

// TestNavigateLongFlatReachable covers Actor.Navigate using the same scaled
// budget: path must be non-empty and Reached for an 80-block flat leg.
func TestNavigateLongFlatReachable(t *testing.T) {
	const floorY = 64
	a := Config{Conn: navStubConn{pos: mgl32.Vec3{0.5, float32(floorY + 1), 0.5}}}.New()
	fillFlatFloor(a.World(), -2, 82, 0, floorY)

	target := cube.Pos{80, floorY + 1, 0}
	a.Navigate(target)
	if !a.Navigating() || a.path.Count() == 0 {
		t.Fatal("Navigate produced no path on open flat ground")
	}
	if !a.path.Reached() {
		t.Fatalf("Navigate did not Reach 80-block flat target; count=%d", a.path.Count())
	}
}

// stuckMoveHandler cancels every Move so the actor never changes position —
// used to drive the fruitless-repath fail-fast without building a physics puzzle.
type stuckMoveHandler struct {
	NopHandler
	stopped int
}

func (h *stuckMoveHandler) HandleMove(ctx *Context, _ *cube.Rotation, _ *mgl64.Vec3) {
	ctx.Cancel()
}

func (h *stuckMoveHandler) HandleStopNavigation(_ *Actor) {
	h.stopped++
}

// TestFruitlessRepathStopsNavigating: when MoveRawInput cannot change position,
// re-pathing is throttled and StopNavigating fires after fruitlessRepathLimit
// attempts (instruction gets "unable to reach destination" via the handler).
func TestFruitlessRepathStopsNavigating(t *testing.T) {
	const floorY = 64
	a := Config{Conn: navStubConn{pos: mgl32.Vec3{0.5, float32(floorY + 1), 0.5}}}.New()
	fillFlatFloor(a.World(), -2, 20, 0, floorY)
	h := &stuckMoveHandler{}
	a.Handle(h)

	a.Navigate(cube.Pos{16, floorY + 1, 0})
	if !a.Navigating() || a.path.Count() == 0 {
		t.Fatal("setup Navigate produced no path")
	}

	// fruitlessRepathLimit re-paths, each followed by repathCooldownTicks idle
	// ticks (plus the re-path tick itself). Generous upper bound.
	maxTicks := fruitlessRepathLimit*(repathCooldownTicks+1) + 5
	for i := 0; i < maxTicks && h.stopped == 0; i++ {
		a.Tick()
	}
	if h.stopped == 0 {
		t.Fatalf("StopNavigating never fired after %d ticks (fruitless=%d cooldown=%d navigating=%v)",
			maxTicks, a.fruitlessRepaths, a.repathCooldown, a.Navigating())
	}
	if a.Navigating() {
		t.Fatal("still Navigating after HandleStopNavigation")
	}
}

// TestFindPathAvoidsDeepPit: flat floor with a 10-deep, 8-wide pit between start
// and target, plus a walkable detour around it. Path must Reach without any
// node inside the pit (including OPEN bridges over the void that used to make
// the bot fall in when CanFloat was left false).
func TestFindPathAvoidsDeepPit(t *testing.T) {
	w := world.NewWorld(false)
	const floorY = 64
	const pitX0, pitX1 = 10, 17 // 8 wide
	const pitZ0, pitZ1 = -2, 2
	const pitDepth = 10

	ensureChunks(w, -2, 40, -8, 16)
	for x := -2; x <= 40; x++ {
		for z := -8; z <= 16; z++ {
			w.SetBlock(cube.Pos{x, floorY, z}, block.Stone{})
		}
	}
	digPit(w, pitX0, pitX1, pitZ0, pitZ1, floorY, pitDepth)

	start := cube.Pos{0, floorY + 1, 0}
	target := cube.Pos{30, floorY + 1, 0}
	feet := start.Vec3().Add(mgl64.Vec3{0.5, 0, 0.5})
	src := pathSource{w: w}
	cfg := walkEvaluatorConfig(cube.Box(-0.3, 0, -0.3, 0.3, 1.8, 0.3), feet)
	dist := feet.Sub(target.Vec3()).Len()
	maxVisited, maxDist := pathfindBudget(dist)
	path := pathfind.FindPath(cfg.New(), src, start, target, maxVisited, maxDist, 1)

	if path.Count() == 0 || !path.Reached() {
		t.Fatalf("expected surface detour around pit; count=%d reached=%v end=%v",
			path.Count(), path.Reached(), path.EndNode())
	}
	if pathHasExcessiveFall(path, maxSafeFallBlocks) {
		t.Fatal("path contains a drop deeper than maxSafeFallBlocks")
	}
	for i := 0; i < path.Count(); i++ {
		n := path.Node(i)
		inPitXZ := n.X() >= pitX0 && n.X() <= pitX1 && n.Z() >= pitZ0 && n.Z() <= pitZ1
		if !inPitXZ {
			continue
		}
		// Any node over/in the pit (OPEN bridge or pit floor) is a failure.
		if n.Y() <= floorY {
			t.Fatalf("path node %v enters pit (floorY=%d)", n.Pos, floorY)
		}
		if _, air := src.Block(cube.Pos{n.X(), floorY, n.Z()}).(block.Air); air {
			t.Fatalf("path node %v bridges OPEN over pit void", n.Pos)
		}
	}
}

// TestNavigateDeepFallUnreachableFailsFast: target only reachable by falling
// >4 blocks. Navigation must StopNavigating within a bounded tick budget
// (partial-path continuations count as fruitless) instead of wandering.
func TestNavigateDeepFallUnreachableFailsFast(t *testing.T) {
	const floorY = 64
	const pitDepth = 10
	a := Config{Conn: navStubConn{pos: mgl32.Vec3{0.5, float32(floorY + 1), 0.5}}}.New()
	ensureChunks(a.World(), -2, 20, -2, 2)
	for x := -2; x <= 20; x++ {
		for z := -2; z <= 2; z++ {
			a.World().SetBlock(cube.Pos{x, floorY, z}, block.Stone{})
		}
	}
	digPit(a.World(), 8, 16, -2, 2, floorY, pitDepth)

	h := &stuckMoveHandler{}
	a.Handle(h)

	// Bottom of pit — only reachable by falling ~10 blocks.
	target := cube.Pos{12, floorY - pitDepth + 1, 0}
	a.Navigate(target)
	if !a.Navigating() {
		// Immediate reject (empty path) is also fine — fail-fast already won.
		if h.stopped == 0 {
			a.StopNavigating()
		}
		return
	}
	if a.path.Reached() {
		t.Fatal("deep-pit target should not be Reached with maxSafeFallBlocks")
	}

	// Finish the partial path immediately so we exercise the !Reached
	// continuation → fruitlessRepathLimit path (not only the stuck-move path).
	for a.path != nil && !a.path.IsDone() {
		a.path.Advance()
	}

	maxTicks := fruitlessRepathLimit*(repathCooldownTicks+1) + 5
	deadline := time.Now().Add(2 * time.Second)
	for i := 0; i < maxTicks && h.stopped == 0; i++ {
		if time.Now().After(deadline) {
			t.Fatalf("exceeded 2s wall clock still navigating (fruitless=%d)", a.fruitlessRepaths)
		}
		a.Tick()
	}
	if h.stopped == 0 {
		t.Fatalf("StopNavigating never fired after %d ticks (fruitless=%d navigating=%v)",
			maxTicks, a.fruitlessRepaths, a.Navigating())
	}
	if a.Navigating() {
		t.Fatal("still Navigating after deep-fall fail-fast")
	}
}

// navStopCounter counts HandleStopNavigation without cancelling Move.
type navStopCounter struct {
	NopHandler
	stopped int
}

func (h *navStopCounter) HandleStopNavigation(_ *Actor) { h.stopped++ }

// TestNavigateBeyondLoadedWalksPartial: destination outside loaded columns must
// still produce a walkable partial path and real XY progress (not instant
// "unable to reach destination" with 0 blocks moved). FindPath may report
// Reached for the clamped loaded-edge goal — that is fine; the true target
// stays on navigationTarget.
func TestNavigateBeyondLoadedWalksPartial(t *testing.T) {
	const floorY = 64
	a := Config{Conn: navStubConn{pos: mgl32.Vec3{0.5, float32(floorY + 1), 0.5}}}.New()
	fillFlatFloor(a.World(), -2, 30, 0, floorY)
	target := cube.Pos{80, floorY + 1, 0}

	h := &navStopCounter{}
	a.Handle(h)
	a.Navigate(target)
	if !a.Navigating() || a.path == nil || a.path.Count() == 0 {
		t.Fatal("expected partial path toward loaded edge for beyond-loaded target")
	}
	if a.navigationTarget != target {
		t.Fatalf("navigationTarget=%v, want true target %v", a.navigationTarget, target)
	}
	if end := a.path.EndNode(); end == nil || end.X() < 10 {
		t.Fatalf("partial path end %#v did not advance toward target", end)
	}

	start := a.Position()
	for i := 0; i < 400 && a.Navigating(); i++ {
		a.Tick()
	}
	moved := a.Position().Sub(start).Len()
	if moved < 5 {
		t.Fatalf("want >=5 blocks toward loaded edge, got %.2f (stopped=%d navigating=%v)",
			moved, h.stopped, a.Navigating())
	}
}

// TestClampGoalToObserved: unloaded targets clamp to the last loaded column
// along the line (chunk-granular — fillFlatFloor to x=20 loads the whole
// chunk covering x=16..31).
func TestClampGoalToObserved(t *testing.T) {
	w := world.NewWorld(false)
	fillFlatFloor(w, -2, 20, 0, 64)
	from := cube.Pos{0, 65, 0}
	to := cube.Pos{80, 65, 0}
	got := clampGoalToObserved(w, from, to)
	if got.X() < 16 || got.X() > 31 {
		t.Fatalf("clampGoalToObserved = %v, want X in loaded chunk range [16,31]", got)
	}
	if !w.Loaded(got) {
		t.Fatalf("clamped goal %v is not loaded", got)
	}
	if clampGoalToObserved(w, from, cube.Pos{10, 65, 0}) != (cube.Pos{10, 65, 0}) {
		t.Fatal("loaded goal should pass through unchanged")
	}
}

// TestTruncatePathBeforeFallKeepsPrefix: a deep drop mid-path must keep the
// walkable prefix (not wipe to empty — that made Navigate fail with 0 progress).
func TestTruncatePathBeforeFallKeepsPrefix(t *testing.T) {
	n0 := &pathfind.Node{Pos: cube.Pos{0, 70, 0}}
	n1 := &pathfind.Node{Pos: cube.Pos{1, 70, 0}}
	n2 := &pathfind.Node{Pos: cube.Pos{2, 70, 0}}
	n3 := &pathfind.Node{Pos: cube.Pos{3, 60, 0}} // 10-block drop
	n4 := &pathfind.Node{Pos: cube.Pos{4, 60, 0}}
	p := pathfind.NewPath([]*pathfind.Node{n0, n1, n2, n3, n4}, true, cube.Pos{4, 60, 0})
	if !pathHasExcessiveFall(p, maxSafeFallBlocks) {
		t.Fatal("setup path should report excessive fall")
	}
	out := truncatePathBeforeFall(p, maxSafeFallBlocks, cube.Pos{4, 60, 0})
	if out.Count() != 3 {
		t.Fatalf("truncated count=%d, want 3 (prefix before fall)", out.Count())
	}
	if out.Reached() {
		t.Fatal("truncated path must not stay Reached")
	}
	if out.EndNode().Pos != (cube.Pos{2, 70, 0}) {
		t.Fatalf("truncated end=%v, want (2,70,0)", out.EndNode().Pos)
	}
}
