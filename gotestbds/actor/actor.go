package actor

import (
	"github.com/df-mc/dragonfly/server/block"
	"github.com/df-mc/dragonfly/server/block/cube"
	"github.com/df-mc/dragonfly/server/item/inventory"
	"github.com/google/uuid"
	"github.com/sandertv/gophertunnel/minecraft"
	"github.com/sandertv/gophertunnel/minecraft/protocol"
	"github.com/sandertv/gophertunnel/minecraft/protocol/packet"
	"github.com/smell-of-curry/go-test-bds/gotestbds/entity"
	"github.com/smell-of-curry/go-test-bds/gotestbds/mcmath"
	"github.com/smell-of-curry/go-test-bds/gotestbds/world"
)

// Actor simulates client actions.
type Actor struct {
	*entity.Player

	world *world.World

	*actorData

	conn *minecraft.Conn
}

// NewActor ...
func NewActor(conn *minecraft.Conn) *Actor {
	identity := conn.IdentityData()
	gameData := conn.GameData()
	pl := entity.CreateFromPacket(&packet.AddPlayer{
		UUID:            uuid.MustParse(identity.Identity),
		Username:        identity.DisplayName,
		EntityRuntimeID: gameData.EntityRuntimeID,
		Position:        gameData.PlayerPosition,
		GameType:        gameData.PlayerGameMode,
	})

	w := world.NewWorld()
	w.AddEntity(pl)

	return &Actor{
		conn:   conn,
		world:  w,
		Player: pl.(*entity.Player),
	}
}

// World ...
func (a *Actor) World() *world.World {
	return a.world
}

// Close ...
func (a *Actor) Close() error {
	// TODO...
	return nil
}

// Attack attacks passed entity.
func (a *Actor) Attack(e world.Entity) bool {
	_, ok := a.world.Entity(e.RuntimeID())
	if !ok {
		return false
	}

	return a.conn.WritePacket(&packet.InventoryTransaction{
		TransactionData: &protocol.UseItemOnEntityTransactionData{
			TargetEntityRuntimeID: e.RuntimeID(),
			ActionType:            protocol.UseItemOnEntityActionAttack,
			HotBarSlot:            int32(a.slot),
			HeldItem:              protocol.ItemInstance{},
			Position:              mcmath.Vec64To32(a.Position()),
			ClickedPosition:       mcmath.Vec64To32(e.Position()),
		},
	}) == nil
}

// BreakBlock breaks block at position passed.
func (a *Actor) BreakBlock(pos cube.Pos) {
	bl := a.World().Block(pos)
	var air block.Air
	if bl == air {
		return
	}

}

// Inventory ...
func (a *Actor) Inventory() *inventory.Inventory {
	return a.inv
}

// Offhand ...
func (a *Actor) Offhand() *inventory.Inventory {
	return a.offhand
}

// Armor ...
func (a *Actor) Armor() *inventory.Armour {
	return a.armor
}

// Tick - simulates client tick.
func (a *Actor) Tick() {
	a.tickMovement()

}
