package testdata

import (
	"github.com/sandertv/gophertunnel/minecraft"
	"github.com/sandertv/gophertunnel/minecraft/protocol"
	"github.com/sandertv/gophertunnel/minecraft/protocol/packet"
)

// CustomCrateName is the identifier used across the join fixture.
const CustomCrateName = "fixture:custom_crate"

// CustomCrateGeometry is the geometry identifier carried only in palette NBT.
const CustomCrateGeometry = "geometry.fixture.custom_crate"

// CustomCrateTexture is the material texture short-name from the palette.
const CustomCrateTexture = "palette_right_texture"

// JoinGameData is a hand-authored GameData fragment that looks like what a
// server sends for one custom block. No behaviour pack is involved.
func JoinGameData() minecraft.GameData {
	return minecraft.GameData{
		CustomBlocks: []protocol.BlockEntry{CustomCrateBlockEntry()},
		Items: []protocol.ItemEntry{
			{
				Name:           "fixture:custom_widget",
				RuntimeID:      20001,
				ComponentBased: true,
				Version:        protocol.ItemEntryVersionDataDriven,
				Data: map[string]any{
					"components": map[string]any{
						"item_properties": map[string]any{
							"minecraft:icon": map[string]any{
								"textures": map[string]any{
									"default": "fixture_custom_widget",
								},
							},
							"max_stack_size": int32(16),
						},
						"minecraft:display_name": map[string]any{
							"value": "Custom Widget",
						},
					},
				},
			},
			// Vanilla-shaped row with no components — must be ignored by LoadItems.
			{Name: "minecraft:stick", RuntimeID: 1, ComponentBased: false},
		},
		PropertyData: ArmadilloPropertyData(),
	}
}

// CustomCrateBlockEntry is the StartGame CustomBlocks row for the crate.
// Shape matches dragonfly blockinternal.ComponentBuilder.Construct output.
func CustomCrateBlockEntry() protocol.BlockEntry {
	return protocol.BlockEntry{
		Name: CustomCrateName,
		Properties: map[string]any{
			"molangVersion": int32(10),
			"menu_category": map[string]any{
				"category": "construction",
				"group":    "",
			},
			"properties": []any{
				map[string]any{
					"name": "fixture:open",
					"enum": []any{false, true},
				},
			},
			"components": map[string]any{
				"minecraft:geometry": map[string]any{
					"identifier": CustomCrateGeometry,
				},
				"minecraft:material_instances": map[string]any{
					"mappings": map[string]any{},
					"materials": map[string]any{
						"*": map[string]any{
							"texture":           CustomCrateTexture,
							"render_method":     "opaque",
							"face_dimming":      true,
							"ambient_occlusion": true,
						},
					},
				},
				"minecraft:transformation": map[string]any{
					"RX": int32(0), "RY": int32(90), "RZ": int32(0),
					"SX": float32(1), "SY": float32(1), "SZ": float32(1),
					"TX": float32(0), "TY": float32(0), "TZ": float32(0),
				},
				"minecraft:light_emission": map[string]any{
					"emission": float32(0.4),
				},
				"minecraft:collision_box": map[string]any{
					"enabled": true,
					"boxes": []any{
						map[string]any{
							"minX": float32(0), "minY": float32(0), "minZ": float32(0),
							"maxX": float32(16), "maxY": float32(16), "maxZ": float32(16),
						},
					},
				},
				"minecraft:selection_box": map[string]any{
					"enabled": true,
					"origin":  []any{float32(-8), float32(0), float32(-8)},
					"size":    []any{float32(16), float32(16), float32(16)},
				},
			},
			"permutations": []any{
				map[string]any{
					"condition": "query.block_state('fixture:open') == true",
					"components": map[string]any{
						"minecraft:geometry": map[string]any{
							"identifier": "geometry.fixture.custom_crate_open",
						},
					},
				},
			},
		},
	}
}

// ArmadilloPropertyData mirrors the SyncActorProperty NBT shape from the
// public Azvyl gist (enum property on minecraft:armadillo).
func ArmadilloPropertyData() map[string]any {
	return map[string]any{
		"type": "minecraft:armadillo",
		"properties": []any{
			map[string]any{
				"name": "minecraft:armadillo_state",
				"type": int32(3),
				"enum": []any{
					"unrolled",
					"rolled_up",
					"rolled_up_peeking",
					"rolled_up_relaxing",
					"rolled_up_unrolling",
				},
				"default": "unrolled",
			},
		},
	}
}

// ItemRegistryPacket is a recorded-looking ItemRegistry carrying the widget.
func ItemRegistryPacket() *packet.ItemRegistry {
	gd := JoinGameData()
	return &packet.ItemRegistry{Items: gd.Items}
}

// SyncActorPropertyPacket is a recorded-looking SyncActorProperty.
func SyncActorPropertyPacket() *packet.SyncActorProperty {
	return &packet.SyncActorProperty{PropertyData: ArmadilloPropertyData()}
}
