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
	var tx *packet.InventoryTransaction
	for _, pk := range conn.written {
		if got, ok := pk.(*packet.InventoryTransaction); ok {
			tx = got
		}
	}
	if tx == nil {
		t.Fatal("no InventoryTransaction")
	}
	data, ok := tx.TransactionData.(*protocol.UseItemTransactionData)
	if !ok {
		t.Fatalf("transaction %T", tx.TransactionData)
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
}
