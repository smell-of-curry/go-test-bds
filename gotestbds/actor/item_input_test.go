package actor

import (
	"testing"

	"github.com/df-mc/dragonfly/server/block"
	"github.com/df-mc/dragonfly/server/block/cube"
	"github.com/df-mc/dragonfly/server/item"
	"github.com/df-mc/dragonfly/server/world"
	"github.com/df-mc/dragonfly/server/world/chunk"
	"github.com/go-gl/mathgl/mgl64"
	"github.com/sandertv/gophertunnel/minecraft/protocol"
	"github.com/sandertv/gophertunnel/minecraft/protocol/packet"
	"github.com/smell-of-curry/go-test-bds/gotestbds/inventory"
	botworld "github.com/smell-of-curry/go-test-bds/gotestbds/world"
)

func newItemInputActor(t *testing.T) (*Actor, *lookRecordingConn) {
	t.Helper()
	a, conn := newLookActor(t)
	a.inv = inventory.NewHandle(36, protocol.WindowIDInventory, nil)
	a.heldSlot = 8
	a.World().AddChunk(world.ChunkPos{0, 1}, botworld.NewColumn(
		chunk.New(world.DefaultBlockRegistry, world.Overworld.Range()), nil,
	))
	return a, conn
}

func tickItemInput(t *testing.T, a *Actor, conn *lookRecordingConn) *packet.PlayerAuthInput {
	t.Helper()
	conn.written = nil
	a.Tick()
	return lookAuthInput(t, conn)
}

// Reproduces setSneaking(true), several idle ticks, then interact: observing
// Sneaking locally is insufficient if the held input is absent on the wire.
func TestSetSneakingPersistsThroughIdleAndItemUse(t *testing.T) {
	a, conn := newItemInputActor(t)
	a.StartSneaking()
	for tick := range 4 {
		if tick == 3 {
			if err := a.UseItem(); err != nil {
				t.Fatal(err)
			}
		}
		pk := tickItemInput(t, a, conn)
		if !pk.InputData.Load(packet.InputFlagSneaking) || !pk.InputData.Load(packet.InputFlagSneakDown) {
			t.Fatalf("tick %d lost held sneak input", tick)
		}
		if pk.InputData.Load(packet.InputFlagStartSneaking) != (tick == 0) {
			t.Fatalf("tick %d has incorrect sneak start edge", tick)
		}
		if pk.InputData.Load(packet.InputFlagPerformItemInteraction) != (tick == 3) {
			t.Fatalf("tick %d has incorrect item-use flag", tick)
		}
	}
	a.StopSneaking()
	for tick := range 2 {
		pk := tickItemInput(t, a, conn)
		if pk.InputData.Load(packet.InputFlagSneaking) || pk.InputData.Load(packet.InputFlagSneakDown) {
			t.Fatalf("tick %d kept sneak input after release", tick)
		}
		if pk.InputData.Load(packet.InputFlagStopSneaking) != (tick == 0) {
			t.Fatalf("tick %d has incorrect sneak stop edge", tick)
		}
	}
}

func TestSneakChangesBeforeSendHaveNoContradictoryFlags(t *testing.T) {
	a, conn := newItemInputActor(t)
	a.StartSneaking()
	a.StopSneaking()
	pk := tickItemInput(t, a, conn)
	if pk.InputData.Load(packet.InputFlagStartSneaking) || pk.InputData.Load(packet.InputFlagSneaking) || pk.InputData.Load(packet.InputFlagSneakDown) {
		t.Fatal("released sneak still carries start/held flags")
	}
	a.StartSneaking()
	pk = tickItemInput(t, a, conn)
	if pk.InputData.Load(packet.InputFlagStopSneaking) || !pk.InputData.Load(packet.InputFlagSneakDown) {
		t.Fatal("pressed sneak carries a stop edge or lacks held input")
	}
}

func TestItemClickSentOnceInAuthInput(t *testing.T) {
	for _, target := range []string{"air", "block"} {
		t.Run(target, func(t *testing.T) {
			a, conn := newItemInputActor(t)
			wantAction := uint32(protocol.UseItemActionClickAir)
			pos := cube.Pos{11, 65, 20}
			var err error
			if target == "block" {
				a.World().SetBlock(pos, block.Stone{})
				wantAction = protocol.UseItemActionClickBlock
				err = a.UseItemOnBlock(pos, cube.FaceWest, mgl64.Vec3{0, .5, .5})
			} else {
				err = a.UseItem()
			}
			if err != nil {
				t.Fatal(err)
			}
			if len(conn.written) != 0 {
				t.Fatalf("one click also sent %d immediate packets before auth input", len(conn.written))
			}
			pk := tickItemInput(t, a, conn)
			data, ok := pk.ItemInteractionData.Value()
			if !ok || !pk.InputData.Load(packet.InputFlagPerformItemInteraction) {
				t.Fatal("click missing from auth input")
			}
			if data.ActionType != wantAction || data.HotBarSlot != 8 || data.TriggerType != protocol.TriggerTypePlayerInput || data.Position != pk.Position {
				t.Fatalf("incorrect item-use data: %+v", data)
			}
			if target == "block" && data.BlockPosition != posToProtocol(pos) {
				t.Fatalf("block position = %v, want %v", data.BlockPosition, pos)
			}
			pk = tickItemInput(t, a, conn)
			if _, ok := pk.ItemInteractionData.Value(); ok || pk.InputData.Load(packet.InputFlagPerformItemInteraction) {
				t.Fatal("one click repeated on the next tick")
			}
		})
	}
}

func TestRapidItemClicksKeepOrderWithoutLoss(t *testing.T) {
	a, conn := newItemInputActor(t)
	pos := cube.Pos{11, 65, 20}
	a.World().SetBlock(pos, block.Stone{})
	if err := a.UseItemOnBlock(pos, cube.FaceWest, mgl64.Vec3{0, .5, .5}); err != nil {
		t.Fatal(err)
	}
	if err := a.UseItem(); err != nil {
		t.Fatal(err)
	}
	if len(conn.written) != 0 {
		t.Fatal("queued clicks also sent standalone transactions")
	}
	for _, want := range []uint32{protocol.UseItemActionClickBlock, protocol.UseItemActionClickAir} {
		pk := tickItemInput(t, a, conn)
		data, ok := pk.ItemInteractionData.Value()
		if !ok || data.ActionType != want {
			t.Fatalf("queued click = %+v (present %v), want action %d", data, ok, want)
		}
	}
	if pk := tickItemInput(t, a, conn); pk.InputData.Load(packet.InputFlagPerformItemInteraction) {
		t.Fatal("two clicks generated a third interaction")
	}
}

type cancelItemInput struct{ NopHandler }

func (cancelItemInput) HandleUseItem(ctx *Context, _ item.Stack) { ctx.Cancel() }

func TestCancelledItemClickDoesNotQueue(t *testing.T) {
	a, conn := newItemInputActor(t)
	a.Handle(cancelItemInput{})
	if err := a.UseItem(); err == nil {
		t.Fatal("cancelled use succeeded")
	}
	if pk := tickItemInput(t, a, conn); pk.InputData.Load(packet.InputFlagPerformItemInteraction) {
		t.Fatal("cancelled click was sent")
	}
}

func TestReleaseItemKeepsStandaloneTransaction(t *testing.T) {
	a, conn := newItemInputActor(t)
	if err := a.ReleaseItem(); err != nil {
		t.Fatal(err)
	}
	if len(conn.written) != 1 {
		t.Fatalf("release sent %d packets, want one", len(conn.written))
	}
	pk, ok := conn.written[0].(*packet.InventoryTransaction)
	if !ok {
		t.Fatalf("release sent %T", conn.written[0])
	}
	if _, ok := pk.TransactionData.(*protocol.ReleaseItemTransactionData); !ok {
		t.Fatalf("release data = %T", pk.TransactionData)
	}
}

func TestReleaseDoesNotOvertakeQueuedUse(t *testing.T) {
	a, conn := newItemInputActor(t)
	if err := a.UseItem(); err != nil {
		t.Fatal(err)
	}
	if err := a.ReleaseItem(); err != nil {
		t.Fatal(err)
	}
	if len(conn.written) != 0 {
		t.Fatal("release overtook the unsent use")
	}
	if pk := tickItemInput(t, a, conn); !pk.InputData.Load(packet.InputFlagPerformItemInteraction) {
		t.Fatal("first tick did not send the use")
	}
	conn.written = nil
	a.Tick()
	if len(conn.written) != 2 {
		t.Fatalf("release tick sent %d packets, want transaction then auth input", len(conn.written))
	}
	tx, ok := conn.written[0].(*packet.InventoryTransaction)
	if !ok {
		t.Fatalf("release tick first packet = %T", conn.written[0])
	}
	if _, ok := tx.TransactionData.(*protocol.ReleaseItemTransactionData); !ok {
		t.Fatalf("release data = %T", tx.TransactionData)
	}
	pk, ok := conn.written[1].(*packet.PlayerAuthInput)
	if !ok || pk.InputData.Load(packet.InputFlagPerformItemInteraction) {
		t.Fatal("release did not pair with an auth input without a duplicate use")
	}
	if pk := tickItemInput(t, a, conn); pk.InputData.Load(packet.InputFlagPerformItemInteraction) {
		t.Fatal("use/release generated a third interaction")
	}
}

func TestLegacyItemTransportSendsClicksOnceInOrder(t *testing.T) {
	a, conn := newItemInputActor(t)
	if err := a.SetItemInteractionTransport(ItemInteractionInventoryTransaction); err != nil {
		t.Fatal(err)
	}
	a.StartSneaking()
	pos := cube.Pos{11, 65, 20}
	a.World().SetBlock(pos, block.Stone{})
	if err := a.UseItemOnBlock(pos, cube.FaceWest, mgl64.Vec3{0, .5, .5}); err != nil {
		t.Fatal(err)
	}
	if err := a.UseItem(); err != nil {
		t.Fatal(err)
	}
	if err := a.ReleaseItem(); err != nil {
		t.Fatal(err)
	}
	if len(conn.written) != 0 {
		t.Fatal("queued legacy input sent before its tick")
	}
	for tick := range 3 {
		conn.written = nil
		a.Tick()
		if len(conn.written) != 2 {
			t.Fatalf("tick %d sent %d packets, want one transaction then auth input", tick, len(conn.written))
		}
		tx, ok := conn.written[0].(*packet.InventoryTransaction)
		if !ok {
			t.Fatalf("tick %d first packet = %T", tick, conn.written[0])
		}
		pk, ok := conn.written[1].(*packet.PlayerAuthInput)
		if !ok || pk.InputData.Load(packet.InputFlagPerformItemInteraction) {
			t.Fatal("legacy interaction duplicated in auth input")
		}
		if _, ok := pk.ItemInteractionData.Value(); ok {
			t.Fatal("legacy auth input carries hidden interaction data")
		}
		if !pk.InputData.Load(packet.InputFlagSneakDown) {
			t.Fatal("legacy input lost persistent sneak")
		}
		if tick == 2 {
			if _, ok := tx.TransactionData.(*protocol.ReleaseItemTransactionData); !ok {
				t.Fatalf("release data = %T", tx.TransactionData)
			}
			continue
		}
		data, ok := tx.TransactionData.(*protocol.UseItemTransactionData)
		if !ok || data.ActionType != uint32(tick) || data.Position != pk.Position || data.HotBarSlot != 8 || data.TriggerType != protocol.TriggerTypePlayerInput {
			t.Fatalf("tick %d incorrect legacy click: %+v", tick, tx.TransactionData)
		}
		if tick == 0 && data.BlockPosition != posToProtocol(pos) {
			t.Fatal("legacy block click lost its target")
		}
	}
	if pk := tickItemInput(t, a, conn); pk.InputData.Load(packet.InputFlagPerformItemInteraction) {
		t.Fatal("legacy clicks repeated after the queue drained")
	}
}

func TestItemTransportValidationPreservesQueuedActions(t *testing.T) {
	a, conn := newItemInputActor(t)
	if err := a.SetItemInteractionTransport("auto"); err == nil {
		t.Fatal("accepted unknown transport")
	}
	if err := a.UseItem(); err != nil {
		t.Fatal(err)
	}
	if err := a.SetItemInteractionTransport(ItemInteractionInventoryTransaction); err == nil {
		t.Fatal("changed transport under a queued click")
	}
	if err := a.SetItemInteractionTransport(ItemInteractionAuthInput); err != nil {
		t.Fatalf("reaffirming the default changed transport: %v", err)
	}
	if pk := tickItemInput(t, a, conn); !pk.InputData.Load(packet.InputFlagPerformItemInteraction) {
		t.Fatal("rejected transport change altered queued click")
	}
	if err := a.SetItemInteractionTransport(ItemInteractionInventoryTransaction); err != nil {
		t.Fatalf("transport still locked after queue drained: %v", err)
	}
}
