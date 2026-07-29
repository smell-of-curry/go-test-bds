package actor

import (
	"github.com/df-mc/dragonfly/server/block/cube"
	"github.com/smell-of-curry/go-test-bds/gotestbds/entity"
	"github.com/smell-of-curry/go-test-bds/gotestbds/inventory"
)

// actorData stores all Actor's data.
type actorData struct {
	heldSlot int
	inv      *inventory.Handle
	offhand  *inventory.Handle
	armor    *inventory.Armour
	ui       *inventory.Handle

	effectManager *entity.EffectManager

	// itemNames maps the server's item network IDs to their names, built on
	// first use from the StartGame item registry.
	itemNames map[int32]string

	breakingBlock bool
	breakingPos   cube.Pos
	breakingTick  int
	abortBreaking bool

	chunkRadius   int
	loadingCenter cube.Pos

	lastForm     *Form
	lastSign     *Sign
	lastDialogue *Dialogue
	messages     *messageRing
	title        *titleState
	camera       *cameraState
	worldTime    *worldTimeState
	particles    *particleRing

	container *Container

	movementData
}
