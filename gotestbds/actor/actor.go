package actor

import (
	"github.com/google/uuid"
	"github.com/sandertv/gophertunnel/minecraft"
	"github.com/sandertv/gophertunnel/minecraft/protocol/packet"
	"github.com/smell-of-curry/go-test-bds/gotestbds/entity"
	"github.com/smell-of-curry/go-test-bds/gotestbds/world"
)

// Actor simulates client actions.
type Actor struct {
	*entity.Player

	world *world.World

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

// Tick - simulates client tick.
func (a *Actor) Tick() {

}
