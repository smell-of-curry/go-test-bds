package wire

import (
	"github.com/sandertv/gophertunnel/minecraft/protocol"
)

// BlockDef is a custom block decoded from the network palette
// (protocol.BlockEntry / GameData.CustomBlocks).
//
// The Properties NBT on the wire is a compound whose top-level keys match what
// dragonfly's blockinternal.ComponentBuilder.Construct emits (and what BDS
// sends for data-driven custom blocks): components, properties, permutations,
// molangVersion, plus creative-menu metadata the renderer ignores.
type BlockDef struct {
	Name          string
	MolangVersion int32
	Properties    []BlockProperty
	Components    BlockComponents
	Permutations  []BlockPermutation
}

// BlockProperty is one state property declared on the block.
type BlockProperty struct {
	Name string
	Enum []any
}

// BlockPermutation is a condition → component override set.
type BlockPermutation struct {
	Condition  string
	Components BlockComponents
}

// BlockComponents are the render-relevant (and a few physics) components.
type BlockComponents struct {
	Geometry          string
	UnitCube          bool
	MaterialInstances map[string]MaterialInstance
	Transformation    *Transformation
	LightEmission     *float32 // 0..1 wire scale when known
	CollisionBox      *Box
	SelectionBox      *SelectionBox
	BoneVisibility    map[string]any
	Raw               map[string]any // unparsed leftovers for later stages
}

// MaterialInstance is one face (or "*") material from minecraft:material_instances.
type MaterialInstance struct {
	Texture          string
	RenderMethod     string
	FaceDimming      bool
	AmbientOcclusion bool
}

// Transformation is minecraft:transformation (RX/RY/RZ, SX/SY/SZ, TX/TY/TZ).
type Transformation struct {
	RX, RY, RZ int32
	SX, SY, SZ float32
	TX, TY, TZ float32
}

// Box is a collision box in pixel coordinates (min/max).
type Box struct {
	Enabled          bool
	MinX, MinY, MinZ float32
	MaxX, MaxY, MaxZ float32
}

// SelectionBox is origin+size selection box in pixel coordinates.
type SelectionBox struct {
	Enabled bool
	Origin  [3]float32
	Size    [3]float32
}

// DecodeBlockEntry projects a protocol.BlockEntry into a BlockDef.
//
// @param e Network block palette entry (name + definition NBT).
// @returns the decoded definition.
func DecodeBlockEntry(e protocol.BlockEntry) BlockDef {
	def := BlockDef{Name: e.Name}
	if e.Properties == nil {
		return def
	}
	if v, ok := mapInt32(e.Properties, "molangVersion"); ok {
		def.MolangVersion = v
	}
	if props, ok := mapSlice(e.Properties, "properties"); ok {
		for _, p := range props {
			pm, ok := asMap(p)
			if !ok {
				continue
			}
			name, _ := mapString(pm, "name")
			var enum []any
			if raw, ok := mapSlice(pm, "enum"); ok {
				enum = raw
			}
			def.Properties = append(def.Properties, BlockProperty{Name: name, Enum: enum})
		}
	}
	if comps, ok := asMap(e.Properties["components"]); ok {
		def.Components = decodeComponents(comps)
	}
	if perms, ok := mapSlice(e.Properties, "permutations"); ok {
		for _, p := range perms {
			pm, ok := asMap(p)
			if !ok {
				continue
			}
			cond, _ := mapString(pm, "condition")
			var comps BlockComponents
			if cm, ok := asMap(pm["components"]); ok {
				comps = decodeComponents(cm)
			}
			def.Permutations = append(def.Permutations, BlockPermutation{
				Condition:  cond,
				Components: comps,
			})
		}
	}
	return def
}

func decodeComponents(comps map[string]any) BlockComponents {
	out := BlockComponents{Raw: map[string]any{}}
	for k, v := range comps {
		switch k {
		case "minecraft:geometry":
			out.Geometry = decodeGeometry(v)
		case "minecraft:unit_cube":
			out.UnitCube = true
		case "minecraft:material_instances":
			out.MaterialInstances = decodeMaterialInstances(v)
		case "minecraft:transformation":
			if m, ok := asMap(v); ok {
				t := decodeTransformation(m)
				out.Transformation = &t
			}
		case "minecraft:light_emission", "minecraft:block_light_emission":
			if em, ok := decodeLightEmission(v); ok {
				out.LightEmission = &em
			}
		case "minecraft:collision_box":
			if m, ok := asMap(v); ok {
				out.CollisionBox = decodeCollisionBox(m)
			}
		case "minecraft:selection_box":
			if m, ok := asMap(v); ok {
				out.SelectionBox = decodeSelectionBox(m)
			}
		case "minecraft:bone_visibility":
			if m, ok := asMap(v); ok {
				out.BoneVisibility = m
			} else {
				out.Raw[k] = v
			}
		default:
			out.Raw[k] = v
		}
	}
	if len(out.Raw) == 0 {
		out.Raw = nil
	}
	return out
}

func decodeGeometry(v any) string {
	switch t := v.(type) {
	case string:
		return t
	case map[string]any:
		if id, ok := mapString(t, "identifier"); ok {
			return id
		}
	}
	return ""
}

func decodeMaterialInstances(v any) map[string]MaterialInstance {
	m, ok := asMap(v)
	if !ok {
		return nil
	}
	materials, ok := asMap(m["materials"])
	if !ok {
		// Some payloads put face keys at the top level.
		materials = m
	}
	out := make(map[string]MaterialInstance, len(materials))
	for face, raw := range materials {
		if face == "mappings" {
			continue
		}
		fm, ok := asMap(raw)
		if !ok {
			continue
		}
		inst := MaterialInstance{}
		inst.Texture, _ = mapString(fm, "texture")
		inst.RenderMethod, _ = mapString(fm, "render_method")
		if b, ok := mapBool(fm, "face_dimming"); ok {
			inst.FaceDimming = b
		}
		if b, ok := mapBool(fm, "ambient_occlusion"); ok {
			inst.AmbientOcclusion = b
		}
		out[face] = inst
	}
	if len(out) == 0 {
		return nil
	}
	return out
}

func decodeTransformation(m map[string]any) Transformation {
	t := Transformation{SX: 1, SY: 1, SZ: 1}
	if v, ok := mapInt32(m, "RX"); ok {
		t.RX = v
	}
	if v, ok := mapInt32(m, "RY"); ok {
		t.RY = v
	}
	if v, ok := mapInt32(m, "RZ"); ok {
		t.RZ = v
	}
	if v, ok := mapFloat32(m, "SX"); ok {
		t.SX = v
	}
	if v, ok := mapFloat32(m, "SY"); ok {
		t.SY = v
	}
	if v, ok := mapFloat32(m, "SZ"); ok {
		t.SZ = v
	}
	if v, ok := mapFloat32(m, "TX"); ok {
		t.TX = v
	}
	if v, ok := mapFloat32(m, "TY"); ok {
		t.TY = v
	}
	if v, ok := mapFloat32(m, "TZ"); ok {
		t.TZ = v
	}
	return t
}

func decodeLightEmission(v any) (float32, bool) {
	switch t := v.(type) {
	case float32:
		return t, true
	case float64:
		return float32(t), true
	case int32:
		// BP JSON often uses an integer 0–15; wire from dragonfly uses 0–1.
		if t > 1 {
			return float32(t) / 15, true
		}
		return float32(t), true
	case int64:
		if t > 1 {
			return float32(t) / 15, true
		}
		return float32(t), true
	case map[string]any:
		if em, ok := mapFloat32(t, "emission"); ok {
			return em, true
		}
		if em, ok := mapInt32(t, "emission"); ok {
			if em > 1 {
				return float32(em) / 15, true
			}
			return float32(em), true
		}
	}
	return 0, false
}

func decodeCollisionBox(m map[string]any) *Box {
	box := &Box{Enabled: true}
	if b, ok := mapBool(m, "enabled"); ok {
		box.Enabled = b
	}
	if boxes, ok := mapSlice(m, "boxes"); ok && len(boxes) > 0 {
		if bm, ok := asMap(boxes[0]); ok {
			box.MinX, _ = mapFloat32(bm, "minX")
			box.MinY, _ = mapFloat32(bm, "minY")
			box.MinZ, _ = mapFloat32(bm, "minZ")
			box.MaxX, _ = mapFloat32(bm, "maxX")
			box.MaxY, _ = mapFloat32(bm, "maxY")
			box.MaxZ, _ = mapFloat32(bm, "maxZ")
		}
	} else {
		// Origin/size form also appears on some payloads.
		if origin, ok := mapSlice(m, "origin"); ok && len(origin) >= 3 {
			box.MinX = anyFloat32(origin[0])
			box.MinY = anyFloat32(origin[1])
			box.MinZ = anyFloat32(origin[2])
		}
		if size, ok := mapSlice(m, "size"); ok && len(size) >= 3 {
			box.MaxX = box.MinX + anyFloat32(size[0])
			box.MaxY = box.MinY + anyFloat32(size[1])
			box.MaxZ = box.MinZ + anyFloat32(size[2])
		}
	}
	return box
}

func decodeSelectionBox(m map[string]any) *SelectionBox {
	box := &SelectionBox{Enabled: true}
	if b, ok := mapBool(m, "enabled"); ok {
		box.Enabled = b
	}
	if origin, ok := mapSlice(m, "origin"); ok && len(origin) >= 3 {
		box.Origin = [3]float32{anyFloat32(origin[0]), anyFloat32(origin[1]), anyFloat32(origin[2])}
	}
	if size, ok := mapSlice(m, "size"); ok && len(size) >= 3 {
		box.Size = [3]float32{anyFloat32(size[0]), anyFloat32(size[1]), anyFloat32(size[2])}
	}
	return box
}

func anyFloat32(v any) float32 {
	switch t := v.(type) {
	case float32:
		return t
	case float64:
		return float32(t)
	case int32:
		return float32(t)
	case int64:
		return float32(t)
	case int:
		return float32(t)
	default:
		return 0
	}
}
