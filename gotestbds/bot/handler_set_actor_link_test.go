package bot

import (
	"testing"

	"github.com/df-mc/dragonfly/server/world"
	"github.com/go-gl/mathgl/mgl32"
	"github.com/sandertv/gophertunnel/minecraft"
	"github.com/sandertv/gophertunnel/minecraft/protocol"
	"github.com/sandertv/gophertunnel/minecraft/protocol/packet"
	"github.com/smell-of-curry/go-test-bds/gotestbds/actor"
	"github.com/smell-of-curry/go-test-bds/gotestbds/entity"
	"github.com/smell-of-curry/go-test-bds/gotestbds/inventory"
	"github.com/smell-of-curry/go-test-bds/gotestbds/mcmath/physics/movement"
)

func newRecordingActor(t *testing.T) (*actor.Actor, *recordingConn) {
	t.Helper()
	world.DefaultBlockRegistry.Finalize()
	conn := &recordingConn{stubConn: stubConn{game: minecraft.GameData{
		EntityRuntimeID: 7,
		EntityUniqueID:  7,
		Dimension:       0,
		ChunkRadius:     4,
		PlayerPosition:  mgl32.Vec3{0.5, 64, 0.5},
	}}}
	a := actor.Config{
		Conn:      conn,
		Inventory: inventory.NewHandle(36, 0, nil),
		Offhand:   inventory.NewHandle(1, 0, nil),
		Armour:    inventory.NewArmour(nil),
		Ui:        inventory.NewHandle(54, 0, nil),
	}.New()
	return a, conn
}

func TestUseItemOnEntitySendsInteract(t *testing.T) {
	a, conn := newRecordingActor(t)
	ent := entity.NewEnt(a.Position(), nil, 5, -99, "minecraft:horse")
	a.World().AddEntity(ent)
	conn.written = nil

	if err := a.UseItemOnEntity(ent); err != nil {
		t.Fatal(err)
	}
	if len(conn.written) != 1 {
		t.Fatalf("packets = %d", len(conn.written))
	}
	tx, ok := conn.written[0].(*packet.InventoryTransaction)
	if !ok {
		t.Fatalf("packet %T", conn.written[0])
	}
	data, ok := tx.TransactionData.(*protocol.UseItemOnEntityTransactionData)
	if !ok {
		t.Fatalf("transaction %T", tx.TransactionData)
	}
	if data.ActionType != protocol.UseItemOnEntityActionInteract {
		t.Fatalf("action = %d, want interact (%d)", data.ActionType, protocol.UseItemOnEntityActionInteract)
	}
	if data.TargetEntityRuntimeID != 5 {
		t.Fatalf("target = %d", data.TargetEntityRuntimeID)
	}
}

func TestSetActorLinkSteerSendsPredictedVehicle(t *testing.T) {
	a, conn := newRecordingActor(t)
	const vehicle int64 = -4200
	err := (&SetActorLinkHandler{}).Handle(&packet.SetActorLink{
		EntityLink: protocol.EntityLink{
			RiddenEntityUniqueID: vehicle,
			RiderEntityUniqueID:  a.UniqueID(),
			Type:                 protocol.EntityLinkRider,
			RiderInitiated:       true,
		},
	}, nil, a)
	if err != nil {
		t.Fatal(err)
	}
	if a.VehicleUniqueID() != vehicle {
		t.Fatalf("vehicle = %d", a.VehicleUniqueID())
	}

	before := a.Position()
	done, err := a.StartHold(movement.Input{Forward: true}, 1)
	if err != nil {
		t.Fatal(err)
	}
	conn.written = nil
	a.Tick()
	select {
	case <-done:
	default:
		t.Fatal("hold did not finish on the steer tick")
	}
	if a.Position() != before {
		t.Fatalf("rider walked locally to %v", a.Position())
	}

	var auth *packet.PlayerAuthInput
	for _, pk := range conn.written {
		if got, ok := pk.(*packet.PlayerAuthInput); ok {
			auth = got
		}
	}
	if auth == nil {
		t.Fatal("no PlayerAuthInput")
	}
	if !auth.InputData.Load(packet.InputFlagClientPredictedVehicle) {
		t.Fatal("missing client-predicted-vehicle flag")
	}
	id, ok := auth.ClientPredictedVehicle.Value()
	if !ok || id != vehicle {
		t.Fatalf("predicted vehicle = %d set=%v", id, ok)
	}
	if auth.MoveVector.Y() <= 0 {
		t.Fatalf("move vector = %v, want forward", auth.MoveVector)
	}

	err = (&SetActorLinkHandler{}).Handle(&packet.SetActorLink{
		EntityLink: protocol.EntityLink{
			RiddenEntityUniqueID: vehicle,
			RiderEntityUniqueID:  a.UniqueID(),
			Type:                 protocol.EntityLinkRemove,
		},
	}, nil, a)
	if err != nil {
		t.Fatal(err)
	}
	if a.VehicleUniqueID() != 0 {
		t.Fatalf("vehicle after unlink = %d", a.VehicleUniqueID())
	}
}
