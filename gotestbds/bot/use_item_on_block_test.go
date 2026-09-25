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
	for _, pk := range conn.written {
		if _, ok := pk.(*packet.InventoryTransaction); ok {
			t.Fatal("block click duplicated as InventoryTransaction")
		}
	}

	conn.written = nil
	a.SendMovement()
	var auth *packet.PlayerAuthInput
	for _, pk := range conn.written {
		if got, ok := pk.(*packet.PlayerAuthInput); ok {
			auth = got
		}
	}
	if auth == nil {
		t.Fatal("no PlayerAuthInput for the click")
	}
	if !auth.InputData.Load(packet.InputFlagPerformItemInteraction) {
		t.Fatal("missing perform-item-interaction flag")
	}
	use, ok := auth.ItemInteractionData.Value()
	if !ok {
		t.Fatal("auth input missing item interaction")
	}
	if use.TriggerType != protocol.TriggerTypePlayerInput || use.BlockRuntimeID != stone {
		t.Fatalf("auth use = trigger %d block %d", use.TriggerType, use.BlockRuntimeID)
	}
	if use.ActionType != protocol.UseItemActionClickBlock {
		t.Fatalf("action = %d", use.ActionType)
	}
	if use.ClientPrediction != protocol.ClientPredictionSuccess {
		t.Fatalf("prediction = %d, want success", use.ClientPrediction)
	}
	if use.BlockPosition.X() != int32(pos.X()) || use.BlockPosition.Y() != int32(pos.Y()) || use.BlockPosition.Z() != int32(pos.Z()) {
		t.Fatalf("block position = %v", use.BlockPosition)
	}
	if use.Position != auth.Position {
		t.Fatalf("use position %v, auth position %v", use.Position, auth.Position)
	}
}
