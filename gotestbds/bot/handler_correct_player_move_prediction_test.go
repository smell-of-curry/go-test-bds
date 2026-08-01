package bot

import (
	"testing"

	"github.com/df-mc/dragonfly/server/world"
	"github.com/go-gl/mathgl/mgl32"
	"github.com/sandertv/gophertunnel/minecraft"
	"github.com/sandertv/gophertunnel/minecraft/protocol/packet"
	"github.com/smell-of-curry/go-test-bds/gotestbds/actor"
	"github.com/smell-of-curry/go-test-bds/gotestbds/inventory"
)

// TestCorrectPlayerMovePredictionUsesEyeOffset: wire position matches
// PlayerAuthInput (eyes). Applying it as feet jammed the bot into ceilings
// so Navigate saw pathNodes>0 and zero displacement.
func TestCorrectPlayerMovePredictionUsesEyeOffset(t *testing.T) {
	world.DefaultBlockRegistry.Finalize()

	conn := &recordingConn{stubConn: stubConn{game: minecraft.GameData{
		EntityRuntimeID: 1,
		EntityUniqueID:  1,
		Dimension:       0,
		ChunkRadius:     8,
		PlayerPosition:  mgl32.Vec3{10.5, 70, 10.5},
	}}}
	a := actor.Config{
		Conn:      conn,
		Inventory: inventory.NewHandle(36, 0, nil),
		Offhand:   inventory.NewHandle(1, 0, nil),
		Armour:    inventory.NewArmour(nil),
		Ui:        inventory.NewHandle(54, 0, nil),
	}.New()

	eyes := mgl32.Vec3{12.5, 70 + eyeOffset, 14.5}
	err := (&CorrectPlayerMovePredictionHandler{}).Handle(&packet.CorrectPlayerMovePrediction{
		Position: eyes,
		Rotation: [2]float32{90, 0},
	}, &Bot{logger: nil}, a)
	if err != nil {
		t.Fatal(err)
	}

	wantY := float64(70)
	if dy := a.Position().Y() - wantY; dy > 0.01 || dy < -0.01 {
		t.Fatalf("feet Y=%v want %v (eyes minus %.2f); old bug left feet at eye height", a.Position().Y(), wantY, eyeOffset)
	}
	if a.Position().X() != 12.5 || a.Position().Z() != 14.5 {
		t.Fatalf("feet XZ=%v,%v want 12.5,14.5", a.Position().X(), a.Position().Z())
	}
}
