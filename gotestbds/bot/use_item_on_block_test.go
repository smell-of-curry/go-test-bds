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
	if len(conn.written) != 2 {
		t.Fatalf("packets = %d, want start and transaction", len(conn.written))
	}
	start, ok := conn.written[0].(*packet.PlayerAction)
	if !ok || start.ActionType != protocol.PlayerActionStartItemUseOn {
		t.Fatalf("first packet = %#v, want start item use", conn.written[0])
	}
	tx, ok := conn.written[1].(*packet.InventoryTransaction)
	if !ok {
		t.Fatalf("second packet = %T, want InventoryTransaction", conn.written[1])
	}
	use, ok := tx.TransactionData.(*protocol.UseItemTransactionData)
	if !ok {
		t.Fatalf("transaction = %T", tx.TransactionData)
	}
	if use.TriggerType != protocol.TriggerTypePlayerInput || use.BlockRuntimeID != stone {
		t.Fatalf("use = trigger %d block %d", use.TriggerType, use.BlockRuntimeID)
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
	if use.ClickedPosition.Y() != 1 {
		t.Fatalf("top-face click y = %v, want 1", use.ClickedPosition.Y())
	}
	eyes := a.EyePos()
	if use.Position.X() != float32(eyes.X()) || use.Position.Y() != float32(eyes.Y()) || use.Position.Z() != float32(eyes.Z()) {
		t.Fatalf("position = %v, want eyes %v", use.Position, eyes)
	}

	conn.written = nil
	a.Tick()
	var stop *packet.PlayerAction
	for _, pk := range conn.written {
		if action, ok := pk.(*packet.PlayerAction); ok && action.ActionType == protocol.PlayerActionStopItemUseOn {
			stop = action
		}
	}
	if stop == nil {
		t.Fatal("next tick did not stop item use")
	}
}
