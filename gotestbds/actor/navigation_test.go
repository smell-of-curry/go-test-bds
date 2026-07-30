package actor

import (
	"testing"
	"time"

	pathfind "github.com/FDUTCH/Pathfinder"
	"github.com/FDUTCH/Pathfinder/evaluator"
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
	cfg := evaluator.WalkNodeEvaluatorConfig{
		Box:          cube.Box(-0.3, 0, -0.3, 0.3, 1.8, 0.3),
		Pos:          mgl64.Vec3{31, 83, -97},
		CanPathDoors: true,
		CanOpenDoors: true,
	}
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

// fillFlatFloor loads columns and a stone floor from minX..maxX at floorY,
// with a 3-wide strip on Z so the pathfinder/physics hitbox has ground.
func fillFlatFloor(w *world.World, minX, maxX, z, floorY int) {
	dfworld.DefaultBlockRegistry.Finalize()
	minChunkX := int32(minX >> 4)
	maxChunkX := int32(maxX >> 4)
	minChunkZ := int32((z - 1) >> 4)
	maxChunkZ := int32((z + 1) >> 4)
	for cx := minChunkX; cx <= maxChunkX; cx++ {
		for cz := minChunkZ; cz <= maxChunkZ; cz++ {
			if _, ok := w.Chunk(dfworld.ChunkPos{cx, cz}); ok {
				continue
			}
			w.AddChunk(
				dfworld.ChunkPos{cx, cz},
				world.NewColumn(chunk.New(dfworld.DefaultBlockRegistry, dfworld.Overworld.Range()), nil),
			)
		}
	}
	for x := minX; x <= maxX; x++ {
		for dz := -1; dz <= 1; dz++ {
			w.SetBlock(cube.Pos{x, floorY, z + dz}, block.Stone{})
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
	cfg := evaluator.WalkNodeEvaluatorConfig{
		Box:          cube.Box(-0.3, 0, -0.3, 0.3, 1.8, 0.3),
		Pos:          feet,
		CanPathDoors: true,
		CanOpenDoors: true,
	}
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
