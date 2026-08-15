package actor

import (
	"testing"

	"github.com/go-gl/mathgl/mgl32"
)

func TestParticleRingFromSeq(t *testing.T) {
	a := &Actor{}
	a.RecordParticleSpawn("minecraft:basic_smoke_particle", mgl32.Vec3{1, 2, 3}, 0, -1)
	a.RecordParticleSpawn("pokeb:shiny_sparkle", mgl32.Vec3{0, 64, 0}, 0, 42)
	if a.ParticleSeq() != 2 {
		t.Fatalf("seq=%d want 2", a.ParticleSeq())
	}
	got := a.ParticlesFromSeq(0)
	if len(got) != 2 {
		t.Fatalf("len=%d want 2", len(got))
	}
	if got[0].Name != "minecraft:basic_smoke_particle" || got[0].Position != (mgl32.Vec3{1, 2, 3}) {
		t.Fatalf("first=%+v", got[0])
	}
	if got[1].EntityUniqueID != 42 {
		t.Fatalf("entity id=%d", got[1].EntityUniqueID)
	}
	if n := len(a.ParticlesFromSeq(2)); n != 0 {
		t.Fatalf("after seq 2 got %d", n)
	}
}
