package wire

import (
	"github.com/sandertv/gophertunnel/minecraft"
	"github.com/sandertv/gophertunnel/minecraft/protocol"
	"github.com/sandertv/gophertunnel/minecraft/protocol/packet"
)

// Registries holds join-sequence definitions projected for the viewer.
//
// Safe use: write and read only on the bot goroutine. Snapshot into JSON there;
// the resulting bytes are immutable and may cross to HTTP writers freely.
type Registries struct {
	Blocks map[string]BlockDef
	Items  map[string]ItemDef
	Actors map[string]ActorTypeProperties // keyed by entity type identifier
}

// NewRegistries returns an empty registry set.
func NewRegistries() *Registries {
	return &Registries{
		Blocks: make(map[string]BlockDef),
		Items:  make(map[string]ItemDef),
		Actors: make(map[string]ActorTypeProperties),
	}
}

// LoadGameData seeds blocks, component-based items, and player PropertyData
// from the connection's GameData. ItemRegistry during login is consumed by
// gophertunnel into GameData.Items before the bot sees packets.
//
// @param gd Connection game data after spawn.
func (r *Registries) LoadGameData(gd minecraft.GameData) {
	r.LoadCustomBlocks(gd.CustomBlocks)
	r.LoadItems(gd.Items)
	if len(gd.PropertyData) > 0 {
		r.LoadActorPropertyData(gd.PropertyData)
	}
}

// LoadCustomBlocks replaces the block palette from StartGame CustomBlocks.
//
// @param entries Network block palette entries.
func (r *Registries) LoadCustomBlocks(entries []protocol.BlockEntry) {
	if r.Blocks == nil {
		r.Blocks = make(map[string]BlockDef, len(entries))
	}
	for _, e := range entries {
		r.Blocks[e.Name] = DecodeBlockEntry(e)
	}
}

// LoadItems stores component-based items (and any entry carrying component NBT).
// Vanilla name-only rows are skipped — the pack stack covers those icons.
//
// @param entries Item registry entries.
func (r *Registries) LoadItems(entries []protocol.ItemEntry) {
	if r.Items == nil {
		r.Items = make(map[string]ItemDef)
	}
	for _, e := range entries {
		if !e.ComponentBased && len(e.Data) == 0 {
			continue
		}
		r.Items[e.Name] = DecodeItemEntry(e)
	}
}

// ApplyItemRegistry merges a late ItemRegistry packet into the item map.
//
// @param pk Item registry packet.
func (r *Registries) ApplyItemRegistry(pk *packet.ItemRegistry) {
	if pk == nil {
		return
	}
	r.LoadItems(pk.Items)
}

// LoadActorPropertyData merges one SyncActorProperty-shaped NBT compound.
//
// @param data Root property NBT.
func (r *Registries) LoadActorPropertyData(data map[string]any) {
	def := DecodeActorPropertyData(data)
	if def.Type == "" && len(def.Properties) == 0 {
		return
	}
	if r.Actors == nil {
		r.Actors = make(map[string]ActorTypeProperties)
	}
	key := def.Type
	if key == "" {
		key = "_"
	}
	r.Actors[key] = def
}

// ApplySyncActorProperty merges a SyncActorProperty packet.
//
// @param pk Actor property sync packet.
func (r *Registries) ApplySyncActorProperty(pk *packet.SyncActorProperty) {
	if pk == nil {
		return
	}
	r.LoadActorPropertyData(pk.PropertyData)
}

// Block returns the palette definition for name, if any.
//
// @param name Block identifier.
// @returns the definition and whether it was present.
func (r *Registries) Block(name string) (BlockDef, bool) {
	if r == nil || name == "" {
		return BlockDef{}, false
	}
	d, ok := r.Blocks[name]
	return d, ok
}

// Item returns the item definition for name, if any.
//
// @param name Item identifier.
// @returns the definition and whether it was present.
func (r *Registries) Item(name string) (ItemDef, bool) {
	if r == nil || name == "" {
		return ItemDef{}, false
	}
	d, ok := r.Items[name]
	return d, ok
}

// ActorProps returns property definitions for an entity type.
//
// @param typeID Entity type identifier.
// @returns the definition set and whether it was present.
func (r *Registries) ActorProps(typeID string) (ActorTypeProperties, bool) {
	if r == nil || typeID == "" {
		return ActorTypeProperties{}, false
	}
	d, ok := r.Actors[typeID]
	return d, ok
}
