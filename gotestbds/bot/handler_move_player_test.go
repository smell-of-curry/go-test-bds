package bot

import (
	"testing"

	"github.com/df-mc/dragonfly/server/block/cube"
	"github.com/df-mc/dragonfly/server/world"
	"github.com/df-mc/dragonfly/server/world/chunk"
	"github.com/go-gl/mathgl/mgl32"
	"github.com/sandertv/gophertunnel/minecraft"
	"github.com/sandertv/gophertunnel/minecraft/protocol"
	"github.com/sandertv/gophertunnel/minecraft/protocol/login"
	"github.com/sandertv/gophertunnel/minecraft/protocol/packet"
	"github.com/smell-of-curry/go-test-bds/gotestbds/actor"
	"github.com/smell-of-curry/go-test-bds/gotestbds/inventory"
	gw "github.com/smell-of-curry/go-test-bds/gotestbds/world"
)

// recordingConn records every WritePacket so tests can assert on the bot's
// outbound replies without a live server.
type recordingConn struct {
	stubConn
	written []packet.Packet
}

func (c *recordingConn) WritePacket(pk packet.Packet) error {
	c.written = append(c.written, pk)
	return nil
}

func (c *recordingConn) IdentityData() login.IdentityData {
	return c.stubConn.IdentityData()
}

// TestMovePlayerTeleportRetainsDestinationChunks covers the long-distance
// teleport failure: MovePlayer snaps the actor away from the old load centre,
// destination LevelChunks can land before NetworkChunkPublisherUpdate, and
// the next Tick's unloadChunks must not discard them as "too far".
func TestMovePlayerTeleportRetainsDestinationChunks(t *testing.T) {
	world.DefaultBlockRegistry.Finalize()

	conn := &recordingConn{stubConn: stubConn{game: minecraft.GameData{
		EntityRuntimeID: 1,
		EntityUniqueID:  1,
		Dimension:       0,
		ChunkRadius:     8,
		PlayerPosition:  mgl32.Vec3{66.5, 82, 0.5},
	}}}
	a := actor.Config{
		Conn:      conn,
		Inventory: inventory.NewHandle(36, 0, nil),
		Offhand:   inventory.NewHandle(1, 0, nil),
		Armour:    inventory.NewArmour(nil),
		Ui:        inventory.NewHandle(54, 0, nil),
	}.New()

	a.SetChunkRadius(8)
	a.SetChunkLoadCenter(cube.Pos{66, 82, 0})
	spawnPos := world.ChunkPos{4, 0}
	a.World().AddChunk(
		spawnPos,
		gw.NewColumn(chunk.New(world.DefaultBlockRegistry, world.Overworld.Range()), nil),
	)

	// Server teleport ~380 blocks away — same ballpark as the live failure.
	destFeet := mgl32.Vec3{96, 220, -376}
	err := (&MovePlayerHandler{}).Handle(&packet.MovePlayer{
		EntityRuntimeID: 1,
		Position:        destFeet.Add(mgl32.Vec3{0, eyeOffset}),
		Mode:            packet.MoveModeTeleport,
	}, nil, a)
	if err != nil {
		t.Fatal(err)
	}

	destPos := world.ChunkPos{6, -24}
	a.World().AddChunk(
		destPos,
		gw.NewColumn(chunk.New(world.DefaultBlockRegistry, world.Overworld.Range()), nil),
	)

	// unloadChunks runs at the end of Tick. Without re-centring on MovePlayer,
	// the destination column is ~24 chunks from the old centre and is removed.
	a.Tick()

	if _, ok := a.World().Chunk(destPos); !ok {
		t.Fatal("destination column pruned after teleport; load centre must follow MovePlayer")
	}
	if _, ok := a.World().Chunk(spawnPos); ok {
		t.Fatal("spawn column should unload once the load centre moves with the teleport")
	}
}

// TestMovePlayerTeleportAcksWithPlayerAuthInput covers the other half of the
// live failure: BDS keeps streaming around the pre-teleport position until the
// client reports itself at the destination. Waiting for the next Tick is too
// late when the packet queue is busy — the handler must ack immediately.
func TestMovePlayerTeleportAcksWithPlayerAuthInput(t *testing.T) {
	world.DefaultBlockRegistry.Finalize()

	conn := &recordingConn{stubConn: stubConn{game: minecraft.GameData{
		EntityRuntimeID: 1,
		EntityUniqueID:  1,
		Dimension:       0,
		ChunkRadius:     8,
		PlayerPosition:  mgl32.Vec3{66.5, 82, 0.5},
	}}}
	a := actor.Config{
		Conn:      conn,
		Inventory: inventory.NewHandle(36, 0, nil),
		Offhand:   inventory.NewHandle(1, 0, nil),
		Armour:    inventory.NewArmour(nil),
		Ui:        inventory.NewHandle(54, 0, nil),
	}.New()
	conn.written = nil

	dest := mgl32.Vec3{96, 220 + eyeOffset, -376}
	err := (&MovePlayerHandler{}).Handle(&packet.MovePlayer{
		EntityRuntimeID: 1,
		Position:        dest,
		Yaw:             90,
		Pitch:           10,
		Mode:            packet.MoveModeTeleport,
	}, nil, a)
	if err != nil {
		t.Fatal(err)
	}

	var auth *packet.PlayerAuthInput
	for _, pk := range conn.written {
		if p, ok := pk.(*packet.PlayerAuthInput); ok {
			auth = p
			break
		}
	}
	if auth == nil {
		t.Fatal("expected PlayerAuthInput ack immediately after MovePlayer teleport")
	}
	if auth.Position.X() != dest.X() || auth.Position.Z() != dest.Z() {
		t.Fatalf("PlayerAuthInput position=%v, want %v", auth.Position, dest)
	}
}

// TestNetworkChunkPublisherUpdateRadiusIsInChunks covers the unit mismatch:
// the packet carries a block radius (chunkRadius<<4); Actor.ChunkRadius and
// unloadChunks speak chunks.
func TestNetworkChunkPublisherUpdateRadiusIsInChunks(t *testing.T) {
	world.DefaultBlockRegistry.Finalize()

	a := actor.Config{
		Conn: stubConn{game: minecraft.GameData{
			EntityRuntimeID: 1,
			EntityUniqueID:  1,
			Dimension:       0,
			ChunkRadius:     8,
		}},
		Inventory: inventory.NewHandle(36, 0, nil),
		Offhand:   inventory.NewHandle(1, 0, nil),
		Armour:    inventory.NewArmour(nil),
		Ui:        inventory.NewHandle(54, 0, nil),
	}.New()

	err := (&NetworkChunkPublisherUpdateHandler{}).Handle(&packet.NetworkChunkPublisherUpdate{
		Position: [3]int32{96, 220, -376},
		Radius:   8 << 4, // blocks, as dragonfly/BDS send it
	}, nil, a)
	if err != nil {
		t.Fatal(err)
	}
	if got := a.ChunkRadius(); got != 8 {
		t.Fatalf("ChunkRadius=%d, want 8 (block radius>>4)", got)
	}
}

// Other players arrive at eye height on every position packet; the viewer
// draws them from Position(), so storing the wire value floats them 1.62 up.
func TestOtherPlayerPositionIsFeet(t *testing.T) {
	world.DefaultBlockRegistry.Finalize()
	conn := &recordingConn{stubConn: stubConn{game: minecraft.GameData{
		EntityRuntimeID: 1,
		EntityUniqueID:  1,
		PlayerPosition:  mgl32.Vec3{0.5, 70 + eyeOffset, 0.5},
	}}}
	a := actor.Config{
		Conn:      conn,
		Inventory: inventory.NewHandle(36, 0, nil),
		Offhand:   inventory.NewHandle(1, 0, nil),
		Armour:    inventory.NewArmour(nil),
		Ui:        inventory.NewHandle(54, 0, nil),
	}.New()
	_ = (&AddEntityHandler{}).Handle(&packet.AddPlayer{EntityRuntimeID: 2, Position: mgl32.Vec3{3, 70 + eyeOffset, 3}}, nil, a)
	other, ok := a.World().Entity(2)
	if !ok {
		t.Fatal("AddPlayer did not add the entity")
	}
	want := func(step string, y float64) {
		t.Helper()
		if got := other.Position().Y(); got < y-0.01 || got > y+0.01 {
			t.Fatalf("%s: Y=%v want %v", step, got, y)
		}
	}
	want("AddPlayer", 70)
	_ = (&MovePlayerHandler{}).Handle(&packet.MovePlayer{EntityRuntimeID: 2, Position: mgl32.Vec3{3, 80 + eyeOffset, 3}}, nil, a)
	want("MovePlayer", 80)
	_ = MoveActorAbsoluteHandler{}.Handle(&packet.MoveActorAbsolute{EntityRuntimeID: 2, Position: mgl32.Vec3{3, 90 + eyeOffset, 3}}, nil, a)
	want("MoveActorAbsolute", 90)
}

// Mobs spawn facing their AddActor yaw and then move by MoveActorDelta; losing
// either leaves every mob facing yaw 0 and frozen at its spawn.
func TestActorRotationAndDeltaMove(t *testing.T) {
	world.DefaultBlockRegistry.Finalize()
	a := actor.Config{
		Conn:      &recordingConn{stubConn: stubConn{game: minecraft.GameData{EntityRuntimeID: 1, EntityUniqueID: 1}}},
		Inventory: inventory.NewHandle(36, 0, nil),
		Offhand:   inventory.NewHandle(1, 0, nil),
		Armour:    inventory.NewArmour(nil),
		Ui:        inventory.NewHandle(54, 0, nil),
	}.New()

	_ = (&AddEntityHandler{}).Handle(&packet.AddActor{EntityRuntimeID: 3, EntityType: "minecraft:pig", Position: mgl32.Vec3{1, 70, 1}, Yaw: 180, Pitch: 10}, nil, a)
	pig, ok := a.World().Entity(3)
	if !ok {
		t.Fatal("AddActor did not add the entity")
	}
	if r := pig.Rotation(); r[0] != 180 || r[1] != 10 {
		t.Fatalf("AddActor rot=%v want [180 10]", r)
	}

	_ = MoveActorDeltaHandler{}.Handle(&packet.MoveActorDelta{EntityRuntimeID: 3, PositionZ: protocol.Option[float32](5), RotationY: protocol.Option[float32](90)}, nil, a)
	if p := pig.Position(); p[0] != 1 || p[1] != 70 || p[2] != 5 {
		t.Fatalf("delta pos=%v want [1 70 5]", p)
	}
	if r := pig.Rotation(); r[0] != 90 || r[1] != 10 {
		t.Fatalf("delta rot=%v want [90 10]", r)
	}
}
