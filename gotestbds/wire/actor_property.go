package wire

// Actor property type IDs on the SyncActorProperty wire (see Azvyl gist /
// client sync of entity properties).
const (
	ActorPropBool  int32 = 1
	ActorPropInt   int32 = 2
	ActorPropEnum  int32 = 3
	ActorPropFloat int32 = 4
)

// ActorTypeProperties is the property definition set for one entity type.
type ActorTypeProperties struct {
	Type       string // entity identifier, e.g. "minecraft:armadillo"
	Properties []ActorPropertyDef
}

// ActorPropertyDef is one typed property a query.property can resolve.
type ActorPropertyDef struct {
	Name    string
	Type    string // "bool" | "int" | "float" | "enum"
	TypeID  int32
	Default any
	Min     *float64
	Max     *float64
	Enum    []string
}

// DecodeActorPropertyData decodes a SyncActorProperty / StartGame PropertyData NBT.
//
// Observed shape (server→client):
//
//	{ "type": "<entity identifier>", "properties": [ { "name", "type", ... } ] }
//
// @param data Root NBT compound from the packet.
// @returns the typed definition set, or a zero value when data is empty.
func DecodeActorPropertyData(data map[string]any) ActorTypeProperties {
	out := ActorTypeProperties{}
	if data == nil {
		return out
	}
	out.Type, _ = mapString(data, "type")
	props, ok := mapSlice(data, "properties")
	if !ok {
		return out
	}
	for _, p := range props {
		pm, ok := asMap(p)
		if !ok {
			continue
		}
		def := ActorPropertyDef{}
		def.Name, _ = mapString(pm, "name")
		if tid, ok := mapInt32(pm, "type"); ok {
			def.TypeID = tid
			def.Type = actorPropTypeName(tid)
		} else if s, ok := mapString(pm, "type"); ok {
			def.Type = s
			def.TypeID = actorPropTypeID(s)
		}
		if v, ok := pm["default"]; ok {
			def.Default = v
		}
		if enum, ok := mapSlice(pm, "enum"); ok {
			for _, e := range enum {
				if s, ok := e.(string); ok {
					def.Enum = append(def.Enum, s)
				}
			}
		}
		if min, ok := anyFloat64(pm["min"]); ok {
			def.Min = &min
		} else if min, ok := anyFloat64(pm["range_min"]); ok {
			def.Min = &min
		}
		if max, ok := anyFloat64(pm["max"]); ok {
			def.Max = &max
		} else if max, ok := anyFloat64(pm["range_max"]); ok {
			def.Max = &max
		}
		// range: [min, max]
		if r, ok := mapSlice(pm, "range"); ok && len(r) >= 2 {
			if min, ok := anyFloat64(r[0]); ok {
				def.Min = &min
			}
			if max, ok := anyFloat64(r[1]); ok {
				def.Max = &max
			}
		}
		out.Properties = append(out.Properties, def)
	}
	return out
}

func actorPropTypeName(id int32) string {
	switch id {
	case ActorPropBool:
		return "bool"
	case ActorPropInt:
		return "int"
	case ActorPropEnum:
		return "enum"
	case ActorPropFloat:
		return "float"
	default:
		return "unknown"
	}
}

func actorPropTypeID(name string) int32 {
	switch name {
	case "bool":
		return ActorPropBool
	case "int":
		return ActorPropInt
	case "enum":
		return ActorPropEnum
	case "float":
		return ActorPropFloat
	default:
		return 0
	}
}

func anyFloat64(v any) (float64, bool) {
	switch t := v.(type) {
	case float64:
		return t, true
	case float32:
		return float64(t), true
	case int32:
		return float64(t), true
	case int64:
		return float64(t), true
	case int:
		return float64(t), true
	default:
		return 0, false
	}
}
