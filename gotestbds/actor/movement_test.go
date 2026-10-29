package actor

import (
	"testing"

	"github.com/df-mc/dragonfly/server/block/cube"
	"github.com/df-mc/dragonfly/server/world"
	"github.com/df-mc/dragonfly/server/world/chunk"
	"github.com/go-gl/mathgl/mgl32"
	"github.com/go-gl/mathgl/mgl64"
	botworld "github.com/smell-of-curry/go-test-bds/gotestbds/world"
)

// TestChunkLoadedAt covers the guard that keeps physics from running against a
// chunk that has not arrived. Without it a bot spawns, reads the missing world
// as air, and falls out of it before its first chunk is received.
func TestChunkLoadedAt(t *testing.T) {
	w := botworld.NewWorld(false)
	pos := mgl64.Vec3{66.5, 78.8, 0.5}

	if chunkLoadedAt(w, pos) {
		t.Fatal("an empty world should report no loaded chunk")
	}

	world.DefaultBlockRegistry.Finalize()
	w.AddChunk(
		world.ChunkPos{4, 0},
		botworld.NewColumn(
			chunk.New(world.DefaultBlockRegistry, world.Overworld.Range()),
			nil,
		),
	)

	if !chunkLoadedAt(w, pos) {
		t.Errorf("position %v should resolve to the chunk added at 4, 0", pos)
	}
	if chunkLoadedAt(w, mgl64.Vec3{-500, 78, 0}) {
		t.Error("a position outside the added chunk should report unloaded")
	}

	// Incomplete columns must NOT count as loaded for physics (same gate as
	// pathSource bedrock) — presence alone used to let physics run on air.
	partial := botworld.NewColumn(
		chunk.New(world.DefaultBlockRegistry, world.Overworld.Range()),
		nil,
	)
	partial.ExpectSubChunks(8)
	w.AddChunk(world.ChunkPos{5, 0}, partial)
	if chunkLoadedAt(w, mgl64.Vec3{80.5, 78.8, 0.5}) {
		t.Error("ColumnRequested/partial column must freeze physics")
	}
}

// TestUnloadKeepsChunksAroundTeleportDestination: BDS streams a teleport
// destination before its publisher update moves the load centre, and never
// resends what the bot drops.
func TestUnloadKeepsChunksAroundTeleportDestination(t *testing.T) {
	world.DefaultBlockRegistry.Finalize()
	a := Config{Conn: navStubConn{pos: mgl32.Vec3{0.5, 65, 0.5}}}.New()
	a.SetChunkLoadCenter(cube.Pos{0, 65, 0})
	a.SetChunkRadius(4)
	a.Move(mgl64.Vec3{160.5, 65, 0.5}, a.Rotation())
	newCol := func() *botworld.Column {
		return botworld.NewColumn(chunk.New(world.DefaultBlockRegistry, world.Overworld.Range()), nil)
	}
	a.World().AddChunk(world.ChunkPos{12, 0}, newCol())
	a.World().AddChunk(world.ChunkPos{40, 0}, newCol())
	a.World().AddChunk(world.ChunkPos{0, 4 + chunkKeepMargin}, newCol())
	a.World().AddChunk(world.ChunkPos{0, 5 + chunkKeepMargin}, newCol())
	a.unloadChunks()
	if _, ok := a.World().Chunk(world.ChunkPos{12, 0}); !ok {
		t.Error("chunk near the actor was pruned against the stale load centre")
	}
	if _, ok := a.World().Chunk(world.ChunkPos{40, 0}); ok {
		t.Error("chunk far from both the centre and the actor should be pruned")
	}
	// BDS sends a little past the radius and never resends what was dropped.
	if _, ok := a.World().Chunk(world.ChunkPos{0, 4 + chunkKeepMargin}); !ok {
		t.Error("chunk inside radius+margin was pruned")
	}
	if _, ok := a.World().Chunk(world.ChunkPos{0, 5 + chunkKeepMargin}); ok {
		t.Error("chunk past radius+margin should be pruned")
	}
}

// TestMoveAccumulatesDeltaBeforePositionUpdate: Move used to call Player.Move
// first then pos.Sub(Position()) — always zero — so walk never reached
// PlayerAuthInput / resolveVelocity.
func TestMoveAccumulatesDeltaBeforePositionUpdate(t *testing.T) {
	a := Config{Conn: navStubConn{pos: mgl32.Vec3{0.5, 65, 0.5}}}.New()
	start := a.Position()
	dest := start.Add(mgl64.Vec3{0.2, 0, 0})
	a.Move(dest, a.Rotation())
	if a.delta.X() < 0.19 {
		t.Fatalf("delta.X=%v want ~0.2 (accumulated before position update)", a.delta.X())
	}
	if !a.Position().ApproxEqual(dest) {
		t.Fatalf("position=%v want %v", a.Position(), dest)
	}
}
