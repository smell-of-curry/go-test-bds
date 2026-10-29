package viewer

import (
	"testing"

	"github.com/go-gl/mathgl/mgl64"
	"github.com/sandertv/gophertunnel/minecraft/protocol"
	"github.com/smell-of-curry/go-test-bds/gotestbds/entity"
	"github.com/smell-of-curry/go-test-bds/gotestbds/wire"
)

// PokeBedrock client entities size and skin themselves from entity
// properties (scripts.scale = q.property('pokeb:scale')); without these the
// viewer draws every Pokémon at scale 1 with the default skin.
func TestEntityPropertiesResolveByName(t *testing.T) {
	reg := wire.NewRegistries()
	reg.LoadActorPropertyData(map[string]any{
		"type": "pokemon:blaziken",
		"properties": []any{
			map[string]any{"name": "pokeb:scale", "type": int32(wire.ActorPropFloat)},
			map[string]any{"name": "pokeb:skin_index", "type": int32(wire.ActorPropInt)},
			map[string]any{"name": "pokeb:shiny", "type": int32(wire.ActorPropBool)},
			map[string]any{"name": "pokeb:mood", "type": int32(wire.ActorPropEnum), "enum": []any{"calm", "angry"}},
		},
	})
	ent := entity.NewEnt(mgl64.Vec3{}, nil, 7, 7, "pokemon:blaziken")
	ent.SetProperties(protocol.EntityProperties{
		FloatProperties:   []protocol.FloatEntityProperty{{Index: 0, Value: 1.5}},
		IntegerProperties: []protocol.IntegerEntityProperty{{Index: 1, Value: 2}, {Index: 2, Value: 1}, {Index: 3, Value: 1}},
	})
	// SetActorData sends only what changed.
	ent.SetProperties(protocol.EntityProperties{IntegerProperties: []protocol.IntegerEntityProperty{{Index: 1, Value: 3}}})

	got := withActorProps(map[string]any{}, reg, ent)
	want := map[string]any{"pokeb:scale": 1.5, "pokeb:skin_index": int32(3), "pokeb:shiny": true, "pokeb:mood": "angry"}
	for k, v := range want {
		if got[k] != v {
			t.Fatalf("%s=%v (%T) want %v; all=%v", k, got[k], got[k], v, got)
		}
	}
}
