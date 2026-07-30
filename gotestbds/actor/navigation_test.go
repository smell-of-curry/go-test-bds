package actor

import (
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
	for cx := int32(minX >> 4); cx <= int32(maxX >> 4); cx++ {
		for cz := int32(minZ >> 4); cz <= int32(maxZ >> 4); cz++ {
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
