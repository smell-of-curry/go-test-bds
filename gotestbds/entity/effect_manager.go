package entity

import (
	"github.com/df-mc/dragonfly/server/entity/effect"
	"iter"
	"maps"
	"reflect"
)

// EffectManager ...
type EffectManager struct {
	effects map[reflect.Type]effect.Effect
}

// Add ...
func (m *EffectManager) Add(e effect.Effect) {
	_, ok := e.Type().(effect.LastingType)
	if !ok {
		return
	}
	typ := reflect.TypeOf(e.Type())

	m.effects[typ] = e
}

// Remove ...
func (m *EffectManager) Remove(e effect.Type) {
	t := reflect.TypeOf(e)
	delete(m.effects, t)
}

// Effect ...
func (m *EffectManager) Effect(e effect.Type) (effect.Effect, bool) {
	existing, ok := m.effects[reflect.TypeOf(e)]
	return existing, ok
}

// Effects ...
func (m *EffectManager) Effects() iter.Seq[effect.Effect] {
	return maps.Values(m.effects)
}
