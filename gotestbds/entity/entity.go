package entity

import (
	"github.com/df-mc/dragonfly/server/block/cube"
	"github.com/df-mc/dragonfly/server/item"
	"github.com/go-gl/mathgl/mgl64"
	"github.com/sandertv/gophertunnel/minecraft/protocol"
	"github.com/smell-of-curry/go-test-bds/gotestbds/entity/attributes"
	"github.com/smell-of-curry/go-test-bds/gotestbds/entity/metadata"
	"github.com/smell-of-curry/go-test-bds/gotestbds/inventory"
)

// Ent is world.Entity implementation for simple entities.
type Ent struct {
	pos        mgl64.Vec3
	rot        cube.Rotation
	vel        mgl64.Vec3
	state      *metadata.State
	attributes *attributes.Values
	armour     *inventory.Armour
	mainHand   item.Stack
	offHand    item.Stack
	rid        uint64
	uid        int64
	entityType string
	headYaw    float64

	// intProps and floatProps are entity property values by wire index; the
	// names live in the SyncActorProperty definitions for entityType.
	intProps   map[uint32]int32
	floatProps map[uint32]float32

	emoteID   string
	emoteTick uint64
	emoteSet  bool
}

// NewEnt ...
//
// @param pos Spawn position.
// @param meta Entity metadata from the spawn packet.
// @param rid Runtime ID used by most entity packets.
// @param uid Unique ID used by RemoveActor. Pass 0 to fall back to rid — spawn
// packets that omit a unique ID (or send 0) must still be removable.
// @param entityType Entity type identifier.
// @returns the new entity.
func NewEnt(pos mgl64.Vec3, meta protocol.EntityMetadata, rid uint64, uid int64, entityType string) *Ent {
	if uid == 0 {
		uid = int64(rid)
	}
	state := new(metadata.State)
	state.Decode(meta)
	return &Ent{pos: pos, state: state, rid: rid, uid: uid, entityType: entityType, attributes: new(attributes.Values), armour: inventory.NewArmour(nil)}
}

// SetProperties merges entity property values. AddActor sends all of them;
// SetActorData sends only the changed ones.
func (e *Ent) SetProperties(p protocol.EntityProperties) {
	if e.intProps == nil {
		e.intProps, e.floatProps = make(map[uint32]int32), make(map[uint32]float32)
	}
	for _, v := range p.IntegerProperties {
		e.intProps[v.Index] = v.Value
	}
	for _, v := range p.FloatProperties {
		e.floatProps[v.Index] = v.Value
	}
}

// Properties returns entity property values by wire index.
func (e *Ent) Properties() (ints map[uint32]int32, floats map[uint32]float32) {
	return e.intProps, e.floatProps
}

// Position is a position of the entity.
func (e *Ent) Position() mgl64.Vec3 {
	return e.pos
}

// Rotation is a rotation of the entity.
func (e *Ent) Rotation() cube.Rotation {
	return e.rot
}

// Velocity is a move vector of the entity.
func (e *Ent) Velocity() mgl64.Vec3 {
	return e.vel
}

// SetVelocity ...
func (e *Ent) SetVelocity(vel mgl64.Vec3) {
	e.vel = vel
}

// State returns state of the entity.
func (e *Ent) State() *metadata.State {
	return e.state
}

// Attributes returns attribute values of the entity.
func (e *Ent) Attributes() *attributes.Values {
	return e.attributes
}

// RuntimeID is runtime identifier of the entity it identifies entity in the packets.
func (e *Ent) RuntimeID() uint64 {
	return e.rid
}

// UniqueID is the unique identifier RemoveActor and similar packets use.
func (e *Ent) UniqueID() int64 {
	return e.uid
}

// Move ...
func (e *Ent) Move(pos mgl64.Vec3, rot cube.Rotation) {
	e.pos = pos
	e.rot = rot
}

// HeadYaw is the head's yaw in degrees; it differs from Rotation().Yaw() when
// the entity has its head turned.
func (e *Ent) HeadYaw() float64 {
	return e.headYaw
}

// SetHeadYaw ...
func (e *Ent) SetHeadYaw(yaw float64) {
	e.headYaw = yaw
}

// Type is a type of the entity it defines how player will see the entity (pig, sheep etc...).
func (e *Ent) Type() string {
	return e.entityType
}

// Armour returns armour.
func (e *Ent) Armour() *inventory.Armour {
	return e.armour
}

// HeldItems returns held items.
func (e *Ent) HeldItems() (main item.Stack, offHand item.Stack) {
	return e.mainHand, e.offHand
}

// SetHeldItems sets held items.
func (e *Ent) SetHeldItems(main, offHand item.Stack) error {
	e.mainHand, e.offHand = main, offHand
	return nil
}

// SetEmote records the latest emote on this entity. A later emote replaces it.
// The entity keeps it until removal; the renderer decides how long to play it.
func (e *Ent) SetEmote(id string, startTick uint64) {
	e.emoteID = id
	e.emoteTick = startTick
	e.emoteSet = id != ""
}

// Emote returns the latest emote, if one has been set.
func (e *Ent) Emote() (id string, startTick uint64, ok bool) {
	if e == nil || !e.emoteSet {
		return "", 0, false
	}
	return e.emoteID, e.emoteTick, true
}
