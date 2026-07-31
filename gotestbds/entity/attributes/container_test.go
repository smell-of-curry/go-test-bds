package attributes

import (
	"testing"

	"github.com/sandertv/gophertunnel/minecraft/protocol"
)

func TestDecodeMovementAttributeAliases(t *testing.T) {
	for _, name := range []string{
		"minecraft:movement",
		"minecraft:movement_speed",
		"minecraft:player.movement_speed",
	} {
		var v Values
		v.Decode([]protocol.Attribute{
			{AttributeValue: protocol.AttributeValue{Name: name, Value: 0.1, Max: 0.1}},
		})
		if v.Speed() < 0.099 || v.Speed() > 0.101 {
			t.Fatalf("%s: Speed()=%v, want ~0.1", name, v.Speed())
		}
	}
}
