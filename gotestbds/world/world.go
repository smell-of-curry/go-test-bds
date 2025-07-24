package world

import (
	"iter"
	"maps"
)

// World stores all entities & blocks.
type World struct {
	entities map[uint64]Entity
	players  map[string]Entity
}

// Entity ...
func (w *World) Entity(rid uint64) (Entity, bool) {
	ent, ok := w.entities[rid]
	return ent, ok
}

// AddEntity ...
func (w *World) AddEntity(ent Entity) {
	w.entities[ent.RuntimeID()] = ent
	if ent.Type() == "minecraft:player" {
		name := ent.(interface{ Name() string }).Name()
		w.players[name] = ent
	}
}

// RemoveEntity ...
func (w *World) RemoveEntity(ent Entity) {
	delete(w.entities, ent.RuntimeID())
	if ent.Type() == "minecraft:player" {
		name := ent.(interface{ Name() string }).Name()
		delete(w.players, name)
	}
}

// Entities ...
func (w *World) Entities() iter.Seq[Entity] {
	return maps.Values(w.entities)
}
