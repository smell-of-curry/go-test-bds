package entity

import (
	"fmt"

	"github.com/sandertv/gophertunnel/minecraft/protocol/packet"
	"github.com/smell-of-curry/go-test-bds/gotestbds/internal"
	"github.com/smell-of-curry/go-test-bds/gotestbds/mcmath"
	"github.com/smell-of-curry/go-test-bds/gotestbds/world"
)

// CreateFromPacket creates an entity from AddPlayer or AddItemActor or AddActor.
func CreateFromPacket(p packet.Packet) world.Entity {
	switch pk := p.(type) {
	case *packet.AddPlayer:
		// AddPlayer carries the unique ID inside AbilityData, not a top-level
		// field. Zero falls back to the runtime ID inside NewEnt.
		return &Player{
			Ent:      NewEnt(mcmath.Vec32To64(pk.Position), pk.EntityMetadata, pk.EntityRuntimeID, pk.AbilityData.EntityUniqueID, ""),
			nick:     pk.Username,
			id:       pk.UUID,
			gamemode: int(pk.GameType),
		}
	case *packet.AddItemActor:
		return &Item{
			Ent:  NewEnt(mcmath.Vec32To64(pk.Position), pk.EntityMetadata, pk.EntityRuntimeID, pk.EntityUniqueID, ""),
			item: internal.StackToItem(pk.Item.Stack),
		}
	case *packet.AddActor:
		return NewEnt(mcmath.Vec32To64(pk.Position), pk.EntityMetadata, pk.EntityRuntimeID, pk.EntityUniqueID, pk.EntityType)
	default:
		panic(fmt.Errorf("unable to create entity from %T", p))
	}
}
