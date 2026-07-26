package world

import (
	"github.com/df-mc/dragonfly/server/block"
	"github.com/df-mc/dragonfly/server/block/model"
	"github.com/df-mc/dragonfly/server/world"
)

// unknownBlockHash keeps UnknownBlock from colliding with a registered block.
var unknownBlockHash = block.NextHash()

// UnknownBlock stands in for a block whose runtime ID the bot cannot decode.
//
// Any server running an addon has blocks this registry has never heard of, and
// their runtime IDs resolve to nothing. Treating those as air is what makes a
// bot fall through a floor built out of them: it leaves the world seconds after
// joining, keeps falling because everything below is air too, and from then on
// every observation of where it is or what is around it is answered from the
// void.
//
// So an undecodable block is solid. A bot may fail to walk through a custom
// block that is really passable, which costs one test a wrong answer; the
// alternative costs the whole run.
type UnknownBlock struct{}

// EncodeBlock returns an identifier that reads as unknown in test output, so a
// failure caused by a block the bot could not decode says so.
//
// @returns the identifier and no properties.
func (UnknownBlock) EncodeBlock() (string, map[string]any) {
	return "gotestbds:unknown", nil
}

// Hash ...
func (UnknownBlock) Hash() (uint64, uint64) {
	return unknownBlockHash, 0
}

// Model returns a full cube, which is what makes the block stand up.
func (UnknownBlock) Model() world.BlockModel {
	return model.Solid{}
}
