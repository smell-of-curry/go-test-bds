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
}
