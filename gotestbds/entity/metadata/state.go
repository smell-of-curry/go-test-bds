package metadata

import (
	"github.com/df-mc/dragonfly/server/block/cube"
	"github.com/sandertv/gophertunnel/minecraft/protocol"
)

// State is the state of the entity on the server side.
type State struct {
	sneaking, sprinting, swimming, crawling, gliding, immobile, usingItem, hasCollision bool
	nameTag                                                                             string
	box                                                                                 cube.BBox

	// Numeric metadata props decoded alongside the flags. The viewer streams
	// every value that Decode understands — dropping one costs a later stage a
	// Molang query — so they live here rather than only inside Box().
	variant, markVariant int32
	scale                float64
	hasVariant           bool
	hasMarkVariant       bool
	hasScale             bool

	// swingSeq counts arm swings observed via packet.Animate. The viewer
	// diffs the counter to trigger a one-shot swing animation.
	swingSeq uint32
}

// Swing returns the arm-swing counter (increments once per observed swing).
func (s *State) Swing() uint32 {
	return s.swingSeq
}

// NoteSwing records one arm swing (packet.Animate ActionSwingArm).
func (s *State) NoteSwing() {
	s.swingSeq++
}

// Sneaking ...
func (s *State) Sneaking() bool {
	return s.sneaking
}

// Sprinting ...
func (s *State) Sprinting() bool {
	return s.sprinting
}

// Swimming ...
func (s *State) Swimming() bool {
	return s.swimming
}

// Crawling ...
func (s *State) Crawling() bool {
	return s.crawling
}

// Gliding ...
func (s *State) Gliding() bool {
	return s.gliding
}

// Immobile ...
func (s *State) Immobile() bool {
	return s.immobile
}

// UsingItem ...
func (s *State) UsingItem() bool {
	return s.usingItem
}

// HasCollision ...
func (s *State) HasCollision() bool {
	return s.hasCollision
}

// NameTag ...
func (s *State) NameTag() string {
	return s.nameTag
}

// Box ...
func (s *State) Box() cube.BBox {
	return s.box
}

// Flags returns every boolean flag Decode understands, keyed by camelCase name.
//
// The viewer ships this map wholesale into entity snapshots. Omitting a flag
// that later Molang stages read is a silent wrong answer, so the set is the
// Decode set — nothing more is invented, nothing that lands is dropped.
//
// @returns flag name → current value.
func (s *State) Flags() map[string]bool {
	return map[string]bool{
		"sneaking":     s.sneaking,
		"sprinting":    s.sprinting,
		"swimming":     s.swimming,
		"crawling":     s.crawling,
		"gliding":      s.gliding,
		"immobile":     s.immobile,
		"usingItem":    s.usingItem,
		"hasCollision": s.hasCollision,
	}
}

// Props returns every numeric metadata property Decode understands.
//
// Keys absent from the last Decode are omitted so a snapshot does not invent
// zeros the server never sent.
//
// @returns property name → value.
func (s *State) Props() map[string]any {
	out := make(map[string]any)
	if s.hasVariant {
		out["variant"] = s.variant
	}
	if s.hasMarkVariant {
		out["markVariant"] = s.markVariant
	}
	if s.hasScale {
		out["scale"] = s.scale
	}
	return out
}

// Decode decodes metadata into State.
func (s *State) Decode(meta protocol.EntityMetadata) {
	if meta == nil {
		return
	}
	// for some reason BDS can send empty metadata.
	if _, found := meta[protocol.EntityDataKeyFlags]; !found {
		meta[protocol.EntityDataKeyFlags] = int64(0)
	}
	s.sneaking = meta.Flag(protocol.EntityDataKeyFlags, protocol.EntityDataFlagSneaking)
	s.sprinting = meta.Flag(protocol.EntityDataKeyFlags, protocol.EntityDataFlagSprinting)
	s.swimming = meta.Flag(protocol.EntityDataKeyFlags, protocol.EntityDataFlagSwimming)
	s.crawling = meta.Flag(protocol.EntityDataKeyFlags, protocol.EntityDataFlagCrawling&63)
	s.gliding = meta.Flag(protocol.EntityDataKeyFlags, protocol.EntityDataFlagGliding)
	s.immobile = meta.Flag(protocol.EntityDataKeyFlags, protocol.EntityDataFlagNoAI)
	s.usingItem = meta.Flag(protocol.EntityDataKeyFlags, protocol.EntityDataFlagUsingItem)
	s.hasCollision = meta.Flag(protocol.EntityDataKeyFlags, protocol.EntityDataFlagHasCollision)
	nameTag, ok := meta[protocol.EntityDataKeyName]
	if ok {
		s.nameTag = nameTag.(string)
	}
	s.box = box(meta)

	s.hasVariant, s.hasMarkVariant, s.hasScale = false, false, false
	if v, ok := meta[protocol.EntityDataKeyVariant]; ok {
		s.variant = asInt32(v)
		s.hasVariant = true
	}
	if v, ok := meta[protocol.EntityDataKeyMarkVariant]; ok {
		s.markVariant = asInt32(v)
		s.hasMarkVariant = true
	}
	if sc, ok := scale(meta); ok {
		s.scale = sc
		s.hasScale = true
	}
}

// asInt32 coerces entity metadata numeric values to int32.
func asInt32(v any) int32 {
	switch n := v.(type) {
	case int32:
		return n
	case int64:
		return int32(n)
	case int:
		return int32(n)
	case float32:
		return int32(n)
	case float64:
		return int32(n)
	default:
		return 0
	}
}
