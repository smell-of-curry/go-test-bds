package bot

import (
	"testing"

	"github.com/go-gl/mathgl/mgl32"
	"github.com/go-gl/mathgl/mgl64"
	"github.com/sandertv/gophertunnel/minecraft"
	"github.com/sandertv/gophertunnel/minecraft/protocol"
	"github.com/sandertv/gophertunnel/minecraft/protocol/packet"
	"github.com/smell-of-curry/go-test-bds/gotestbds/actor"
	"github.com/smell-of-curry/go-test-bds/gotestbds/entity"
	"github.com/smell-of-curry/go-test-bds/gotestbds/inventory"
)

// TestMoveActorAbsoluteRotation: the packet's rotation is pitch, body yaw,
// head yaw. A turned head (head yaw != body yaw) used to be decoded as a
// direction vector, which put the yaw into the pitch.
func TestMoveActorAbsoluteRotation(t *testing.T) {
	conn := &recordingConn{stubConn: stubConn{game: minecraft.GameData{EntityRuntimeID: 1, EntityUniqueID: 1}}}
	a := actor.Config{
		Conn:      conn,
		Inventory: inventory.NewHandle(36, 0, nil),
		Offhand:   inventory.NewHandle(1, 0, nil),
		Armour:    inventory.NewArmour(nil),
		Ui:        inventory.NewHandle(54, 0, nil),
	}.New()
	ent := entity.NewEnt(mgl64.Vec3{0, 64, 0}, protocol.EntityMetadata{}, 7, 7, "pokemon:lapras")
	a.World().AddEntity(ent)

	pk := &packet.MoveActorAbsolute{EntityRuntimeID: 7, Position: mgl32.Vec3{1, 64, 2}, Rotation: mgl32.Vec3{20, 90, 120}}
	if err := (MoveActorAbsoluteHandler{}).Handle(pk, nil, a); err != nil {
		t.Fatal(err)
	}
	if rot := ent.Rotation(); rot.Yaw() != 90 || rot.Pitch() != 20 {
		t.Fatalf("rotation = yaw %v pitch %v, want yaw 90 pitch 20", rot.Yaw(), rot.Pitch())
	}
	if ent.HeadYaw() != 120 {
		t.Fatalf("head yaw = %v, want 120", ent.HeadYaw())
	}
}
