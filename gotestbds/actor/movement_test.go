package actor

import (
	"testing"

	"github.com/df-mc/dragonfly/server/world"
	"github.com/df-mc/dragonfly/server/world/chunk"
	"github.com/go-gl/mathgl/mgl32"
	"github.com/go-gl/mathgl/mgl64"
	"github.com/sandertv/gophertunnel/minecraft/protocol/packet"
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

// tickRecordingConn records outbound packets so auth-input tick can be asserted.
type tickRecordingConn struct {
	navStubConn
	written []packet.Packet
}

func (c *tickRecordingConn) WritePacket(pk packet.Packet) error {
	c.written = append(c.written, pk)
	return nil
}

func authTick(t *testing.T, conn *tickRecordingConn) uint64 {
	t.Helper()
	for i := len(conn.written) - 1; i >= 0; i-- {
		if pk, ok := conn.written[i].(*packet.PlayerAuthInput); ok {
			return pk.Tick
		}
	}
	t.Fatal("no PlayerAuthInput written")
	return 0
}

// TestSendMovementCatchesTickUpToServer: a tick loop that starts late must
// not keep sending StartGame.Time. BDS drops stale PlayerAuthInput, which
// leaves the server rotation at spawn.
func TestSendMovementCatchesTickUpToServer(t *testing.T) {
	conn := &tickRecordingConn{navStubConn: navStubConn{pos: mgl32.Vec3{1, 64, 1}}}
	a := Config{Conn: conn}.New()
	conn.written = nil

	a.SetWorldTime(1180)
	a.SendMovement()
	if got := authTick(t, conn); got != 1180 {
		t.Fatalf("tick=%d want 1180 (world time ahead of the local counter)", got)
	}

	conn.written = nil
	a.tick = 2000
	a.SetWorldTime(1100)
	a.SendMovement()
	if got := authTick(t, conn); got != 2000 {
		t.Fatalf("tick=%d want 2000 (must not rewind behind a later local tick)", got)
	}

	conn.written = nil
	a.tick = 1000
	a.NoteServerMovement(false, false, 1500)
	a.SetWorldTime(9000)
	a.SendMovement()
	if got := authTick(t, conn); got != 1500 {
		t.Fatalf("tick=%d want 1500 (movement packet tick wins over world time)", got)
	}
}
