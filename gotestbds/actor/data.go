package actor

import (
	"github.com/df-mc/dragonfly/server/block/cube"
	"github.com/smell-of-curry/go-test-bds/gotestbds/entity"
	"github.com/smell-of-curry/go-test-bds/gotestbds/inventory"
)

// actorData ...
type actorData struct {
	slot    int
	inv     *inventory.Handle
	offhand *inventory.Handle
	armor   *Armour

	effectManager *entity.EffectManager

	breakingBlock bool
	breakingPos   cube.Pos
	breakingTick  int
	abortBreaking bool

	movementData
}
