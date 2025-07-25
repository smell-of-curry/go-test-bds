package metadata

import (
	"github.com/df-mc/dragonfly/server/block/cube"
	"github.com/sandertv/gophertunnel/minecraft/protocol"
)

// width extracts width from the metadata.
func width(meta protocol.EntityMetadata) (float64, bool) {
	width, ok := meta[protocol.EntityDataKeyWidth]
	if !ok {
		return 0.6, false
	}
	return float64(width.(float32)), true
}

// height extracts height from the metadata.
func height(meta protocol.EntityMetadata) (float64, bool) {
	width, ok := meta[protocol.EntityDataKeyHeight]
	if !ok {
		return 1.8, false
	}
	return float64(width.(float32)), true
}

// scale extracts scale from the metadata.
func scale(meta protocol.EntityMetadata) (float64, bool) {
	width, ok := meta[protocol.EntityDataKeyScale]
	if !ok {
		return 1, false
	}
	return float64(width.(float32)), true
}

// box calculates hitbox from the metadata.
func box(meta protocol.EntityMetadata) cube.BBox {
	w, _ := width(meta)
	h, _ := height(meta)
	s, _ := scale(meta)
	halfWidth := (w / 2) * s
	h *= s
	return cube.Box(-halfWidth, 0, -halfWidth, halfWidth, h, halfWidth)
}
