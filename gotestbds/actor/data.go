package actor

import (
	"github.com/smell-of-curry/go-test-bds/gotestbds/inventory"
)

// actorData ...
type actorData struct {
	slot    int
	inv     *inventory.Handle
	offhand *inventory.Handle
	armor   *inventory.Handle

	movementData
}
