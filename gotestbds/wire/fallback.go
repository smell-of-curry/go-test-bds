package wire

// FallbackKind is the three-way classification a renderer uses when a block
// cannot be drawn from palette + pack assets.
type FallbackKind string

const (
	// FallbackAbsent — no block present (air, or the column is not loaded).
	FallbackAbsent FallbackKind = "absent"
	// FallbackUnnamed — block occupies space but the registry could not name
	// it: empty name with a non-zero network runtime ID.
	FallbackUnnamed FallbackKind = "unnamed_but_present"
	// FallbackNamedUnknown — named in the snapshot, but neither the network
	// palette nor the caller’s pack resolution produced an appearance.
	FallbackNamedUnknown FallbackKind = "named_but_unknown"
	// FallbackResolved — palette or packs can draw it; not a fallback case.
	FallbackResolved FallbackKind = "resolved"
)

// BlockRef is the snapshot Block fields ClassifyFallback needs — kept free of
// the viewer package so wire tests stay pack-free.
type BlockRef struct {
	Name string
	RID  uint32
}

// ClassifyFallback distinguishes the three unresolved cases (and resolved).
//
// Rules (also documented in viewer/PROTOCOL.md):
//   - absent: name is minecraft:air (or empty with rid 0) — nothing to draw
//   - unnamed_but_present: name == "" && rid != 0
//   - named_but_unknown: name != "" && name != air && !inPalette && !appearanceOK
//   - resolved: appearanceOK (caller already resolved geometry/texture)
//
// @param b Snapshot block identity.
// @param inPalette Whether the network palette has an entry for b.Name.
// @param appearanceOK Whether ResolveBlockAppearance (or pack lookup) succeeded.
// @returns the fallback classification.
func ClassifyFallback(b BlockRef, inPalette, appearanceOK bool) FallbackKind {
	if b.Name == "minecraft:air" || (b.Name == "" && b.RID == 0) {
		return FallbackAbsent
	}
	if b.Name == "" && b.RID != 0 {
		return FallbackUnnamed
	}
	if appearanceOK || inPalette {
		// inPalette without appearanceOK still means the definition arrived;
		// missing pack assets are a pack problem, not "unknown identity".
		if appearanceOK {
			return FallbackResolved
		}
	}
	if b.Name != "" {
		return FallbackNamedUnknown
	}
	return FallbackAbsent
}
