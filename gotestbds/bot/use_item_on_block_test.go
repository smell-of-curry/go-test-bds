package bot

import (
	"testing"

	"github.com/df-mc/dragonfly/server/block"
	"github.com/df-mc/dragonfly/server/block/cube"
	"github.com/df-mc/dragonfly/server/world"
	"github.com/df-mc/dragonfly/server/world/chunk"
	"github.com/go-gl/mathgl/mgl64"
	"github.com/sandertv/gophertunnel/minecraft/protocol"
	"github.com/sandertv/gophertunnel/minecraft/protocol/packet"
	gw "github.com/smell-of-curry/go-test-bds/gotestbds/world"
)

// TestUseItemOnBlockSendsAcceptedClick covers the fields BDS silently rejects
// when they stay at their zero value: an unknown trigger, a predicted failure,
// a player at the origin, and block runtime id 0 (air). A rejected click never
// becomes a playerInteractWithBlock, so spawn eggs and entity placers do nothing.
func TestUseItemOnBlockSendsAcceptedClick(t *testing.T) {
	a, conn := newRecordingActor(t)
	world.DefaultBlockRegistry.Finalize()

	pos := cube.Pos{0, 63, 0}
	stone := world.BlockRuntimeID(block.Stone{})
	a.World().AddChunk(world.ChunkPos{0, 0}, gw.NewColumn(
		chunk.New(world.DefaultBlockRegistry, world.Overworld.Range()), nil,
	))
	a.World().SetBlockRuntimeID(pos, stone, 0)
	conn.written = nil

	click := mgl64.Vec3{0.5, 1, 0.5}
	if err := a.UseItemOnBlock(pos, cube.FaceUp, click); err != nil {
		t.Fatal(err)
	}
	if len(conn.written) != 0 {
		t.Fatal("click was sent before its auth-input tick")
	}
	a.SendMovement()
	if len(conn.written) != 1 {
		t.Fatalf("one click sent %d packets, want one auth input", len(conn.written))
	}
	auth, ok := conn.written[0].(*packet.PlayerAuthInput)
	if !ok || !auth.InputData.Load(packet.InputFlagPerformItemInteraction) {
		t.Fatal("click missing from auth input")
	}
	data, ok := auth.ItemInteractionData.Value()
	if !ok {
		t.Fatal("auth input missing item interaction")
	}
	if data.ActionType != protocol.UseItemActionClickBlock {
		t.Fatalf("action = %d", data.ActionType)
	}
	if data.TriggerType != protocol.TriggerTypePlayerInput {
		t.Fatalf("trigger = %d, want player input", data.TriggerType)
	}
	if data.ClientPrediction != protocol.ClientPredictionSuccess {
		t.Fatalf("prediction = %d, want success", data.ClientPrediction)
	}
	if data.BlockRuntimeID != stone {
		t.Fatalf("block runtime id = %d, want %d", data.BlockRuntimeID, stone)
	}
	eyes := a.EyePos()
	if data.Position.X() != float32(eyes.X()) || data.Position.Y() != float32(eyes.Y()) || data.Position.Z() != float32(eyes.Z()) {
		t.Fatalf("position = %v, want eyes %v", data.Position, eyes)
	}
	if data.BlockPosition.X() != int32(pos.X()) || data.BlockPosition.Y() != int32(pos.Y()) || data.BlockPosition.Z() != int32(pos.Z()) {
		t.Fatalf("block position = %v", data.BlockPosition)
	}

	if data.Position != auth.Position {
		t.Fatalf("use position %v, auth position %v", data.Position, auth.Position)
	}
	conn.written = nil
	a.Tick()
	for _, pk := range conn.written {
		if _, duplicate := pk.(*packet.InventoryTransaction); duplicate {
			t.Fatal("click duplicated in a standalone transaction")
		}
		if input, ok := pk.(*packet.PlayerAuthInput); ok && input.InputData.Load(packet.InputFlagPerformItemInteraction) {
			t.Fatal("click repeated on the next tick")
		}
	}
}

// TestUseItemSendsAcceptedThrow covers the click-air path (throwables such as
// snowballs and projectile items): BDS drops it with an unknown trigger and
// the next PlayerAuthInput must carry the use without a standalone duplicate.
func TestUseItemSendsAcceptedThrow(t *testing.T) {
	a, conn := newRecordingActor(t)
	conn.written = nil
	if err := a.UseItem(); err != nil {
		t.Fatal(err)
	}
	if len(conn.written) != 0 {
		t.Fatal("click-air sent a standalone transaction before auth input")
	}
	a.SendMovement()
	if len(conn.written) != 1 {
		t.Fatalf("click-air sent %d packets, want one", len(conn.written))
	}
	auth, ok := conn.written[0].(*packet.PlayerAuthInput)
	if !ok || !auth.InputData.Load(packet.InputFlagPerformItemInteraction) {
		t.Fatal("throw did not ride the next PlayerAuthInput")
	}
	data, ok := auth.ItemInteractionData.Value()
	if !ok || data.ActionType != protocol.UseItemActionClickAir {
		t.Fatalf("no click-air transaction: %+v", data)
	}
	if data.TriggerType != protocol.TriggerTypePlayerInput || data.ClientPrediction != protocol.ClientPredictionSuccess {
		t.Fatalf("trigger %d prediction %d", data.TriggerType, data.ClientPrediction)
	}
}
