package wire

// AppearanceSource names which definition produced a ResolvedAppearance.
type AppearanceSource string

const (
	SourcePalette    AppearanceSource = "palette"
	SourceBlocksJSON AppearanceSource = "blocks_json"
	SourceNone       AppearanceSource = "none"
)

// ResolvedAppearance is what the renderer should draw for a named block after
// applying network-palette vs blocks.json precedence.
type ResolvedAppearance struct {
	Source            AppearanceSource
	Geometry          string
	UnitCube          bool
	MaterialInstances map[string]MaterialInstance
	// Texture is the legacy blocks.json short-name, set only when Source is
	// blocks_json (or as a soft hint when the palette has no materials).
	Texture string
}

// ResolveBlockAppearance applies the established precedence:
//
//  1. Network palette components win for geometry and material_instances when
//     either is present.
//  2. Otherwise a blocks.json texture/sound row may supply a legacy atlas name.
//  3. Otherwise SourceNone.
//
// Evidence for (1): see viewer/FINDINGS-wire.md — custom block geometry is not
// a blocks.json field; BDS/dragonfly put it only in the StartGame palette NBT.
//
// @param name Block identifier from the snapshot.
// @param palette Palette definition for name, or nil.
// @param blocksJSON Resource-pack blocks.json row for name, or nil.
// @returns the resolved appearance.
func ResolveBlockAppearance(name string, palette *BlockDef, blocksJSON *BlocksJSONEntry) ResolvedAppearance {
	_ = name
	if palette != nil {
		hasGeo := palette.Components.Geometry != "" || palette.Components.UnitCube
		hasMat := len(palette.Components.MaterialInstances) > 0
		if hasGeo || hasMat {
			return ResolvedAppearance{
				Source:            SourcePalette,
				Geometry:          palette.Components.Geometry,
				UnitCube:          palette.Components.UnitCube,
				MaterialInstances: palette.Components.MaterialInstances,
			}
		}
	}
	if blocksJSON != nil {
		if tex, ok := blocksJSON.TextureName(); ok {
			return ResolvedAppearance{
				Source:  SourceBlocksJSON,
				Texture: tex,
			}
		}
	}
	return ResolvedAppearance{Source: SourceNone}
}
