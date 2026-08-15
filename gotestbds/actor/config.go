package actor

import (
	"github.com/df-mc/dragonfly/server/block/cube"
	dfworld "github.com/df-mc/dragonfly/server/world"
	"github.com/google/uuid"
	"github.com/sandertv/gophertunnel/minecraft/protocol"
	"github.com/sandertv/gophertunnel/minecraft/protocol/packet"
	"github.com/smell-of-curry/go-test-bds/gotestbds/entity"
	"github.com/smell-of-curry/go-test-bds/gotestbds/inventory"
	"github.com/smell-of-curry/go-test-bds/gotestbds/mcmath"
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
		AbilityData:     protocol.AbilityData{EntityUniqueID: gameData.EntityUniqueID},
	})

	w := world.NewWorld(gameData.UseBlockNetworkIDHashes)
	w.SetDimension(gameData.Dimension)
	w.AddEntity(pl)

	data := actorData{
		inv:           c.Inventory,
		offhand:       c.Offhand,
		armor:         c.Armour,
		ui:            c.Ui,
		effectManager: entity.NewEffectManager(),
		chunkRadius:   int(gameData.ChunkRadius),
		// Until the first NetworkChunkPublisherUpdate, unload against spawn —
		// leaving this at {0,0,0} would prune a spawn far from the origin.
		loadingCenter: cube.PosFromVec3(mcmath.Vec32To64(gameData.PlayerPosition)),
	}

	data.movementBitset = protocol.NewBitset(packet.PlayerAuthInputBitsetSize)

	data.mc = &physics.Computer{
		Gravity:           0.08,
		Drag:              0.02,
		DragBeforeGravity: true,
	}

	// The bot never constructs a dragonfly server/world, so nothing else
	// finalizes the block registry for us. Chunk decoding needs it finalized.
	dfworld.DefaultBlockRegistry.Finalize()

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
