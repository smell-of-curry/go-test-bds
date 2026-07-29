package bot

import (
	"testing"

	"github.com/df-mc/dragonfly/server/block/cube"
	"github.com/df-mc/dragonfly/server/item"
	"github.com/go-gl/mathgl/mgl64"
	"github.com/sandertv/gophertunnel/minecraft"
	"github.com/sandertv/gophertunnel/minecraft/protocol/packet"
	"github.com/smell-of-curry/go-test-bds/gotestbds/actor"
	"github.com/smell-of-curry/go-test-bds/gotestbds/entity/attributes"
	"github.com/smell-of-curry/go-test-bds/gotestbds/entity/metadata"
	"github.com/smell-of-curry/go-test-bds/gotestbds/inventory"
)

// swingEnt is a minimal world.Entity with a persistent metadata state.
type swingEnt struct {
	rid   uint64
	state metadata.State
}

func (e *swingEnt) Position() mgl64.Vec3                      { return mgl64.Vec3{} }
func (e *swingEnt) Rotation() cube.Rotation                   { return cube.Rotation{} }
func (e *swingEnt) Velocity() mgl64.Vec3                      { return mgl64.Vec3{} }
func (e *swingEnt) SetVelocity(mgl64.Vec3)                    {}
func (e *swingEnt) State() *metadata.State                    { return &e.state }
func (e *swingEnt) Attributes() *attributes.Values            { return &attributes.Values{} }
func (e *swingEnt) Armour() *inventory.Armour                 { return inventory.NewArmour(nil) }
func (e *swingEnt) HeldItems() (item.Stack, item.Stack)       { return item.Stack{}, item.Stack{} }
func (e *swingEnt) SetHeldItems(item.Stack, item.Stack) error { return nil }
func (e *swingEnt) RuntimeID() uint64                         { return e.rid }
func (e *swingEnt) UniqueID() int64                           { return int64(e.rid) }
func (e *swingEnt) Move(mgl64.Vec3, cube.Rotation)            {}
func (e *swingEnt) Type() string                              { return "minecraft:player" }

// TestAnimateSwingArmBumpsEntitySwingCounter covers the viewer's arm-swing
// source: an Animate swing on a tracked entity increments its counter, other
// actions and unknown entities leave everything untouched.
func TestAnimateSwingArmBumpsEntitySwingCounter(t *testing.T) {
	a := actor.Config{
		Conn: stubConn{game: minecraft.GameData{
			EntityRuntimeID: 1,
			EntityUniqueID:  1,
		}},
		Inventory: inventory.NewHandle(36, 0, nil),
		Offhand:   inventory.NewHandle(1, 0, nil),
		Armour:    inventory.NewArmour(nil),
		Ui:        inventory.NewHandle(54, 0, nil),
	}.New()

	ent := &swingEnt{rid: 7}
	a.World().AddEntity(ent)

	h := &AnimateHandler{}
	if err := h.Handle(&packet.Animate{
		ActionType:      packet.AnimateActionSwingArm,
		EntityRuntimeID: 7,
	}, nil, a); err != nil {
		t.Fatal(err)
	}
	if got := ent.State().Swing(); got != 1 {
		t.Fatalf("swing counter = %d, want 1", got)
	}

	// Non-swing actions do not bump.
	if err := h.Handle(&packet.Animate{
		ActionType:      packet.AnimateActionCriticalHit,
		EntityRuntimeID: 7,
	}, nil, a); err != nil {
		t.Fatal(err)
	}
	if got := ent.State().Swing(); got != 1 {
		t.Fatalf("swing counter after critical hit = %d, want 1", got)
	}

	// Unknown entity: cosmetic packet, no error.
	if err := h.Handle(&packet.Animate{
		ActionType:      packet.AnimateActionSwingArm,
		EntityRuntimeID: 999,
	}, nil, a); err != nil {
		t.Fatalf("unknown entity should be ignored, got %v", err)
	}
}
