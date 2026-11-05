package bot

import (
	"testing"

	"github.com/df-mc/dragonfly/server/block/cube"
	"github.com/df-mc/dragonfly/server/world"
	"github.com/go-gl/mathgl/mgl32"
	"github.com/go-gl/mathgl/mgl64"
	"github.com/sandertv/gophertunnel/minecraft"
	"github.com/sandertv/gophertunnel/minecraft/protocol/packet"
	"github.com/smell-of-curry/go-test-bds/gotestbds/actor"
	"github.com/smell-of-curry/go-test-bds/gotestbds/inventory"
	"github.com/smell-of-curry/go-test-bds/gotestbds/mcmath/physics/movement"
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

// TestCorrectIgnoredWhileNavigating: soft corrects must not snap the bot back
// mid-path (live 11b3e4a: Correct every ~300ms → navigate deadline, 0 arrive).
func TestCorrectIgnoredWhileNavigating(t *testing.T) {
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

	// Force navigating=true via a non-nil path handle: Navigate on empty world
	// yields an empty path which is still Navigating() until fail.
	a.Navigate(cube.Pos{20, 70, 20})
	if !a.Navigating() {
		t.Fatal("setup: expected Navigating after Navigate")
	}
	before := a.Position()
	err := (&CorrectPlayerMovePredictionHandler{}).Handle(&packet.CorrectPlayerMovePrediction{
		Position: mgl32.Vec3{99, 70 + eyeOffset, 99},
		Rotation: [2]float32{0, 0},
	}, &Bot{logger: nil}, a)
	if err != nil {
		t.Fatal(err)
	}
	if a.Position() != before {
		t.Fatalf("Correct moved actor while navigating: %v → %v", before, a.Position())
	}
}

// Player prediction corrections must preserve the look both during a held
// walk and after release. Rotation belongs to vehicle prediction only.
func TestPlayerCorrectionPreservesLookDuringAndAfterHold(t *testing.T) {
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

	a.Move(a.Position(), cube.Rotation{180, 12})
	if _, err := a.StartHold(movement.Input{Forward: true}, 80); err != nil {
		t.Fatal(err)
	}
	err := (&CorrectPlayerMovePredictionHandler{}).Handle(&packet.CorrectPlayerMovePrediction{
		Position: mgl32.Vec3{12.5, 70 + eyeOffset, 14.5}, Rotation: mgl32.Vec2{0, 0},
	}, nil, a)
	if err != nil {
		t.Fatal(err)
	}
	if a.Rotation() != (cube.Rotation{180, 12}) {
		t.Fatalf("historical correction replaced held look: %v", a.Rotation())
	}
	if a.Position().X() != 12.5 || a.Position().Z() != 14.5 {
		t.Fatalf("position correction not applied: %v", a.Position())
	}
	a.StopHold()
	// Reproduce the quest shot: turn toward the NPC after arriving, then
	// receive another position correction while standing still.
	a.LookAt(a.EyePos().Add(mgl64.Vec3{10, 1, -4}))
	look, head := a.Rotation(), a.HeadYaw()
	for _, rotation := range []mgl32.Vec2{{0, 0}, {45, 5}} {
		_ = (&CorrectPlayerMovePredictionHandler{}).Handle(&packet.CorrectPlayerMovePrediction{
			Position: mgl32.Vec3{13.5, 70 + eyeOffset, 15.5}, Rotation: rotation,
		}, nil, a)
		if a.Rotation() != look || a.HeadYaw() != head {
			t.Fatalf("idle player correction changed look/head to %v/%v, want %v/%v", a.Rotation(), a.HeadYaw(), look, head)
		}
		if a.Position().X() != 13.5 || a.Position().Z() != 15.5 {
			t.Fatalf("idle position correction not applied: %v", a.Position())
		}
	}

	before := a.Position()
	_ = (&CorrectPlayerMovePredictionHandler{}).Handle(&packet.CorrectPlayerMovePrediction{
		PredictionType: packet.PredictionTypeVehicle,
		Position:       mgl32.Vec3{99, 80, 99}, Rotation: mgl32.Vec2{45, 5},
	}, nil, a)
	if a.Position() != before || a.Rotation() != look || a.HeadYaw() != head {
		t.Fatal("vehicle correction moved or turned its rider as a player")
	}

	// Authoritative teleports/turns are still accepted through MovePlayer.
	_ = (&MovePlayerHandler{}).Handle(&packet.MovePlayer{
		EntityRuntimeID: a.RuntimeID(), Position: mgl32.Vec3{20, 75 + eyeOffset, 22},
		Yaw: 45, Pitch: 5, HeadYaw: 45, Mode: packet.MoveModeTeleport,
	}, nil, a)
	if a.Rotation() != (cube.Rotation{45, 5}) || a.HeadYaw() != 45 || a.Position().X() != 20 {
		t.Fatalf("server teleport lost its rotation/position: %v/%v", a.Rotation(), a.Position())
	}
}
