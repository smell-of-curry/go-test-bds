package actor

import (
	"testing"
	"time"

	pathfind "github.com/FDUTCH/Pathfinder"
	"github.com/FDUTCH/Pathfinder/evaluator"
	"github.com/df-mc/dragonfly/server/block"
	"github.com/df-mc/dragonfly/server/block/cube"
	"github.com/go-gl/mathgl/mgl64"
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
