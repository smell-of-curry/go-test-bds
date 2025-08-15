package actor

import (
	_ "unsafe"

	"github.com/google/uuid"
	"github.com/sandertv/gophertunnel/minecraft/protocol"
	"github.com/sandertv/gophertunnel/minecraft/protocol/packet"
	"github.com/smell-of-curry/go-test-bds/gotestbds/entity"
	"github.com/smell-of-curry/go-test-bds/gotestbds/inventory"
	"github.com/smell-of-curry/go-test-bds/gotestbds/mcmath/physics"
	"github.com/smell-of-curry/go-test-bds/gotestbds/world"
)

// Config ...
type Config struct {
	Conn      Conn
	Inventory *inventory.Handle
	Offhand   *inventory.Handle
	Armour    *inventory.Armour
	Ui        *inventory.Handle
}

// New creates new Actor.
func (c Config) New() (actor *Actor) {

	identity := c.Conn.IdentityData()
	gameData := c.Conn.GameData()

	pl := entity.CreateFromPacket(&packet.AddPlayer{
		UUID:            uuid.MustParse(identity.Identity),
		Username:        identity.DisplayName,
		EntityRuntimeID: gameData.EntityRuntimeID,
		Position:        gameData.PlayerPosition,
		GameType:        gameData.PlayerGameMode,
	})

	w := world.NewWorld()
	w.AddEntity(pl)

	data := actorData{
		inv:           c.Inventory,
		offhand:       c.Offhand,
		armor:         c.Armour,
		effectManager: entity.NewEffectManager(),
		chunkRadius:   int(gameData.ChunkRadius),
	}

	data.movementBitset = protocol.NewBitset(packet.PlayerAuthInputBitsetSize)

	data.mc = &physics.Computer{
		Gravity:           0.08,
		Drag:              0.02,
		DragBeforeGravity: true,
	}

	finaliseBlockRegistry()

	actor = &Actor{
		conn:      c.Conn,
		world:     w,
		Player:    pl.(*entity.Player),
		actorData: data,
		h:         NopHandler{},
	}
	actor.prepare()

	return actor
}

//go:linkname finaliseBlockRegistry github.com/df-mc/dragonfly/server/world.finaliseBlockRegistry
func finaliseBlockRegistry()
