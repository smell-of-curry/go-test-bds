package actor

import (
	"fmt"

	"github.com/df-mc/dragonfly/server/block/cube"
	"github.com/df-mc/dragonfly/server/world"
	"github.com/sandertv/gophertunnel/minecraft/protocol/packet"
)

// NewSign ...
func NewSign(bl world.NBTer, pos cube.Pos, isFrontSide bool, conn Conn) *Sign {
	return &Sign{bl: bl, pos: pos, isFrontSide: isFrontSide, conn: conn}
}

// Sign represents all editable objects.
type Sign struct {
	bl          world.NBTer
	pos         cube.Pos
	isFrontSide bool
	edited      bool
	conn        Conn
}

// Edit sends changes to the server.
func (s *Sign) Edit(text string) error {
	if s.edited {
		return fmt.Errorf("sign has already been edited")
	}
	s.edited = true

	textData := map[string]any{"Text": text}
	nbt := s.bl.EncodeNBT()
	if nbt == nil {
		nbt = make(map[string]any)
	}

	if s.isFrontSide {
		nbt["FrontText"] = textData
	} else {
		nbt["BackText"] = textData
	}

	return s.conn.WritePacket(&packet.BlockActorData{
		Position: posToProtocol(s.pos),
		NBTData:  nbt,
	})
}

// Pos returns position of the object.
func (s *Sign) Pos() cube.Pos {
	return s.pos
}

// Front returns whether the editable side is front.
func (s *Sign) Front() bool {
	return s.isFrontSide
}

// Object returns editable object.
func (s *Sign) Object() world.NBTer {
	return s.bl
}
