package wire

import (
	"github.com/sandertv/gophertunnel/minecraft/protocol"
)

// ItemDef is a custom / component-based item from packet.ItemRegistry.
type ItemDef struct {
	Name           string
	ComponentBased bool
	Version        int32
	Icon           string // textures.default from minecraft:icon, if present
	Components     map[string]any
	Properties     map[string]any // item_properties sub-map when present
}

// DecodeItemEntry projects a protocol.ItemEntry.
//
// RuntimeID is intentionally dropped — identity on the viewer wire is the name.
//
// @param e Item registry entry.
// @returns the decoded definition.
func DecodeItemEntry(e protocol.ItemEntry) ItemDef {
	def := ItemDef{
		Name:           e.Name,
		ComponentBased: e.ComponentBased,
		Version:        e.Version,
	}
	if e.Data == nil {
		return def
	}
	comps, ok := asMap(e.Data["components"])
	if !ok {
		// Older / odd payloads may put components at the root.
		comps = e.Data
	}
	def.Components = comps
	if props, ok := asMap(comps["item_properties"]); ok {
		def.Properties = props
		def.Icon = iconFromProperties(props)
	}
	if def.Icon == "" {
		def.Icon = iconFromProperties(comps)
	}
	return def
}

func iconFromProperties(m map[string]any) string {
	icon, ok := asMap(m["minecraft:icon"])
	if !ok {
		return ""
	}
	if textures, ok := asMap(icon["textures"]); ok {
		if def, ok := mapString(textures, "default"); ok {
			return def
		}
	}
	// Legacy: minecraft:icon as a bare string texture name.
	if s, ok := mapString(icon, "texture"); ok {
		return s
	}
	return ""
}
