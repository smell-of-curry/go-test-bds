package actor

import (
	"github.com/sandertv/gophertunnel/minecraft/protocol/packet"
	"github.com/smell-of-curry/go-test-bds/gotestbds/wire"
)

// WireRegistries returns the join-sequence registries, or nil when the viewer
// path has never enabled them. Nil means "pay nothing" — packet handlers no-op.
func (a *Actor) WireRegistries() *wire.Registries {
	return a.wireReg
}

// EnsureWireRegistries decodes GameData custom blocks, component items and
// PropertyData into a Registries once. Safe to call repeatedly; subsequent
// calls are no-ops. Must run on the bot goroutine.
//
// Call only when a viewer is attached — decoding the full ItemRegistry into
// filtered maps is join-once work we skip for headless runs.
func (a *Actor) EnsureWireRegistries() *wire.Registries {
	if a.wireReg != nil {
		return a.wireReg
	}
	r := wire.NewRegistries()
	r.LoadGameData(a.conn.GameData())
	a.wireReg = r
	return r
}

// ApplyItemRegistry merges a late ItemRegistry packet when registries are live.
func (a *Actor) ApplyItemRegistry(pk *packet.ItemRegistry) {
	if a.wireReg == nil || pk == nil {
		return
	}
	a.wireReg.ApplyItemRegistry(pk)
}

// ApplySyncActorProperty merges a SyncActorProperty packet when registries are live.
func (a *Actor) ApplySyncActorProperty(pk *packet.SyncActorProperty) {
	if a.wireReg == nil || pk == nil {
		return
	}
	a.wireReg.ApplySyncActorProperty(pk)
}
