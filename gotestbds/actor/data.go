package actor

import (
	"github.com/df-mc/dragonfly/server/block/cube"
	"github.com/smell-of-curry/go-test-bds/gotestbds/entity"
	"github.com/smell-of-curry/go-test-bds/gotestbds/inventory"
)

// actorData ...
type actorData struct {
	heldSlot int
	inv      *inventory.Handle
	offhand  *inventory.Handle
	armor    *inventory.Armour
	ui       *inventory.Handle

	effectManager *entity.EffectManager

	breakingBlock bool
	breakingPos   cube.Pos
	breakingTick  int
	abortBreaking bool

	chunkRadius   int
	loadingCenter cube.Pos

	lastForm     *Form
	lastSign     *Sign
	lastDialogue *Dialogue

	container *Container

	movementData
}
