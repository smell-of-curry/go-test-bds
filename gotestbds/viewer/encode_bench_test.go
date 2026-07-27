package viewer

import (
	"testing"

	"github.com/df-mc/dragonfly/server/block"
	"github.com/df-mc/dragonfly/server/block/cube"
	dfworld "github.com/df-mc/dragonfly/server/world"
	"github.com/go-gl/mathgl/mgl64"
	"github.com/smell-of-curry/go-test-bds/gotestbds/actor"
)

// populateBenchWorld fills a Chebyshev radius-4 neighbourhood (81 columns)
// with 8 non-air sections each. Actor sits at y=70 so sectionRadius 4 covers
// every populated section.
func populateBenchWorld(b *testing.B) (*actor.Actor, *encoder) {
	b.Helper()
	a := testActor(b, "BenchBot")
	a.Move(mgl64.Vec3{8, 70, 8}, cube.Rotation{})
	w := a.World()
	for dx := int32(-4); dx <= 4; dx++ {
		for dz := int32(-4); dz <= 4; dz++ {
			addColumn(w, dfworld.ChunkPos{dx, dz})
			baseX := int(dx) * 16
			baseZ := int(dz) * 16
			for _, y := range []int{0, 16, 32, 48, 64, 80, 96, 112} {
				w.SetBlock(cube.Pos{baseX + 1, y, baseZ + 1}, block.Stone{})
			}
		}
	}
	return a, newEncoder("BenchBot", 4, 4)
}

func BenchmarkEncoderSteadyNoCache(b *testing.B) {
	a, enc := populateBenchWorld(b)
	enc.skipColCache = true
	if _, _, err := enc.frame(a); err != nil {
		b.Fatal(err)
	}
	b.ResetTimer()
	for i := 0; i < b.N; i++ {
		if _, _, err := enc.frame(a); err != nil {
			b.Fatal(err)
		}
	}
}

func BenchmarkEncoderSteadyCached(b *testing.B) {
	a, enc := populateBenchWorld(b)
	if _, _, err := enc.frame(a); err != nil {
		b.Fatal(err)
	}
	b.ResetTimer()
	for i := 0; i < b.N; i++ {
		if _, _, err := enc.frame(a); err != nil {
			b.Fatal(err)
		}
	}
}

func BenchmarkEncoderOneBlockChange(b *testing.B) {
	a, enc := populateBenchWorld(b)
	if _, _, err := enc.frame(a); err != nil {
		b.Fatal(err)
	}
	pos := cube.Pos{1, 70, 1}
	b.ResetTimer()
	for i := 0; i < b.N; i++ {
		if i%2 == 0 {
			a.World().SetBlock(pos, block.Dirt{})
		} else {
			a.World().SetBlock(pos, block.Stone{})
		}
		if _, _, err := enc.frame(a); err != nil {
			b.Fatal(err)
		}
	}
}
