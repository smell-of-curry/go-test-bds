package actor

import (
	"fmt"

	"github.com/df-mc/dragonfly/server/block"
	"github.com/df-mc/dragonfly/server/block/cube"
	w "github.com/df-mc/dragonfly/server/world"
	"github.com/sandertv/gophertunnel/minecraft/protocol"
	"github.com/sandertv/gophertunnel/minecraft/protocol/packet"
	"github.com/smell-of-curry/go-test-bds/gotestbds/inventory"
	"github.com/smell-of-curry/go-test-bds/gotestbds/world"
)

// Container contains all information related to external container.
type Container struct {
	pk            *packet.ContainerOpen
	bl            w.Block
	containerType byte
	handle        *inventory.Handle

	closed       bool
	actionWriter inventory.ActionWriter
	conn         Conn
}

// NewContainerFromPacket ...
func NewContainerFromPacket(pk *packet.ContainerOpen, actionWriter inventory.ActionWriter, conn Conn) *Container {
	return &Container{
		pk:            pk,
		containerType: pk.ContainerType,
		actionWriter:  actionWriter,
		conn:          conn,
	}
}

// Source ...
func (c *Container) Source(w *world.World) (any, error) {
	ent, ok := w.Entity(uint64(c.pk.ContainerEntityUniqueID))
	if ok {
		return ent, nil
	}
	if c.pk.ContainerEntityUniqueID != -1 {
		return nil, fmt.Errorf("unknown source")
	}

	return w.Block(c.Position()), nil
}

// Inventory ...
func (c *Container) Inventory() *inventory.Handle {
	if c.handle == nil {
		c.handle = inventory.NewHandle(c.inventorySizeByType(int(c.containerType)), uint32(c.pk.WindowID), c.actionWriter)
	}
	return c.handle
}

// Close ...
func (c *Container) Close() error {
	if c.closed {
		return fmt.Errorf("container already closed")
	}
	c.closed = true
	return c.conn.WritePacket(&packet.ContainerClose{
		WindowID:      byte(c.Inventory().ID()),
		ContainerType: c.containerType,
	})
}

// inventorySizeByType returns inventory size by type.
func (c *Container) inventorySizeByType(invType int) int {
	switch invType {
	case protocol.ContainerTypeBrewingStand, protocol.ContainerTypeHopper:
		return 5
	case protocol.ContainerTypeContainer:
		chest := c.bl.(block.Chest)
		if chest.Paired() {
			return 54
		}
		return 27
	case protocol.ContainerTypeFurnace, protocol.ContainerTypeBlastFurnace, protocol.ContainerTypeSmoker:
		return 3
	default:
		return 3
	}
}

// Position returns position on the container.
func (c *Container) Position() cube.Pos {
	pos := c.pk.ContainerPosition
	return cube.Pos{int(pos[0]), int(pos[1]), int(pos[2])}
}
