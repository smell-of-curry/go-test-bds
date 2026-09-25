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

func TestActorPreparationOnlyFinishesLoading(t *testing.T) {
	_, conn := newRecordingActor(t)
	if len(conn.written) != 1 {
		t.Fatalf("preparation packets = %d, want 1", len(conn.written))
	}
	loading, ok := conn.written[0].(*packet.ServerBoundLoadingScreen)
	if !ok || loading.Type != packet.LoadingScreenTypeEnd {
		t.Fatalf("preparation packet = %#v, want loading-screen end", conn.written[0])
	}
}

func TestLookAtSynchronisesRotationBeforeAction(t *testing.T) {
	a, conn := newRecordingActor(t)
	conn.written = nil

	a.LookAt(a.EyePos().Add(mgl64.Vec3{1, 0, 0}))

	if len(conn.written) != 1 {
		t.Fatalf("packets = %d, want one PlayerAuthInput", len(conn.written))
	}
	auth, ok := conn.written[0].(*packet.PlayerAuthInput)
	if !ok {
		t.Fatalf("packet = %T, want PlayerAuthInput", conn.written[0])
	}
	if auth.Yaw != -90 || auth.InteractYaw != -90 {
		t.Fatalf("yaw = %v, interact yaw = %v, want -90", auth.Yaw, auth.InteractYaw)
	}
	if !auth.InputData.Load(packet.InputFlagBlockBreakingDelayEnabled) {
		t.Fatal("auth input missing block-breaking delay flag")
	}
	if !auth.InputData.Load(packet.InputFlagClientAckServerData) {
		t.Fatal("auth input missing server-data acknowledgement")
	}
	if auth.InputMode != packet.InputModeMouse ||
		auth.InteractionModel != packet.InteractionModelTouch {
		t.Fatalf("input mode = %d, interaction model = %d", auth.InputMode, auth.InteractionModel)
	}
}

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
	if len(conn.written) != 3 {
		t.Fatalf("packets = %d, want start, transaction, stop", len(conn.written))
	}
	start, ok := conn.written[0].(*packet.PlayerAction)
	if !ok || start.ActionType != protocol.PlayerActionStartItemUseOn {
		t.Fatalf("first packet = %#v, want start item use", conn.written[0])
	}
	tx, ok := conn.written[1].(*packet.InventoryTransaction)
	if !ok {
		t.Fatalf("second packet = %T, want InventoryTransaction", conn.written[1])
	}
	stop, ok := conn.written[2].(*packet.PlayerAction)
	if !ok || stop.ActionType != protocol.PlayerActionStopItemUseOn {
		t.Fatalf("third packet = %#v, want stop item use", conn.written[2])
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
	if len(use.Actions) != 1 {
		t.Fatalf("inventory actions = %d, want 1", len(use.Actions))
	}
	if use.Actions[0].SourceType != protocol.InventoryActionSourceContainer ||
		use.Actions[0].InventorySlot != uint32(a.HeldSlot()) {
		t.Fatalf("inventory action = %#v", use.Actions[0])
	}
	if use.BlockPosition.X() != int32(pos.X()) || use.BlockPosition.Y() != int32(pos.Y()) || use.BlockPosition.Z() != int32(pos.Z()) {
		t.Fatalf("block position = %v", use.BlockPosition)
	}
	if use.ClickedPosition.Y() != 1 {
		t.Fatalf("top-face click y = %v, want 1", use.ClickedPosition.Y())
	}
	feet := a.Position()
	if use.Position.X() != float32(feet.X()) || use.Position.Y() != float32(feet.Y()) || use.Position.Z() != float32(feet.Z()) {
		t.Fatalf("position = %v, want feet %v", use.Position, feet)
	}
}
